//! Volume backups: scheduled jobs that archive a volume (tar.gz) and upload it
//! to a destination, keep the last N, and restore any of them.
//!
//! Archives are made and restored by short-lived helper containers with the
//! volume mounted, so this works wherever the volume data lives (including
//! Docker Desktop's VM). Each run is an update, visible in Activity.

use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    str::FromStr,
    time::Duration,
};

use anyhow::{Context, bail};
use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    routing::{get, post, put},
};
use bollard::{
    Docker,
    container::LogOutput,
    exec::StartExecResults,
    models::{ContainerCreateBody, ExecConfig, HostConfig, Mount, MountType},
    query_parameters::{
        CreateContainerOptions, ListContainersOptions, RemoveContainerOptions, StartContainerOptions, StopContainerOptions,
    },
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use crate::{
    auth::User,
    backup_destinations::{self, Destination, get_destination, human},
    deployments::system_user,
    error::{AppError, AppResult},
    state::{AppState, now},
    updates::{self, Update, UpdateLog},
    volume_browser::{HELPER_LABEL, ensure_image},
};

const HELPER_KIND: &str = "backup";
const ARCHIVE_IMAGE: &str = "alpine:3.20";
/// Fallback when an rclone/local listing returns lots of stderr.
const MAX_CAPTURE: usize = 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .nest("/destinations", backup_destinations::router())
        .route("/", get(list_backups))
        .route("/schedule", get(preview_schedule))
        .route("/jobs", get(list_jobs).post(create_job))
        .route("/jobs/{id}", put(update_job).delete(delete_job))
        .route("/jobs/{id}/run", post(run_job))
        .route("/volumes/{volume}/run", post(run_once))
        .route("/{id}", axum::routing::delete(delete_backup))
        .route("/{id}/restore", post(restore))
}

// ---- Helper containers -------------------------------------------------------

pub struct HelperSpec {
    image: &'static str,
    /// Volume mounted at /vol, and whether read-only.
    volume: Option<(String, bool)>,
    network: bool,
}

impl HelperSpec {
    pub fn rclone() -> Self {
        Self { image: backup_destinations::RCLONE_IMAGE, volume: None, network: true }
    }

    fn volume(name: &str, read_only: bool) -> Self {
        Self { image: ARCHIVE_IMAGE, volume: Some((name.to_string(), read_only)), network: false }
    }
}

/// A throwaway container for one operation, removed when dropped.
pub struct Helper {
    docker: Docker,
    id: String,
}

impl Drop for Helper {
    fn drop(&mut self) {
        let (docker, id) = (self.docker.clone(), self.id.clone());
        tokio::spawn(async move {
            let _ = docker.remove_container(&id, Some(RemoveContainerOptions { force: true, ..Default::default() })).await;
        });
    }
}

impl Helper {
    pub async fn start(state: &AppState, spec: HelperSpec) -> anyhow::Result<Self> {
        Self::start_on(&state.docker, spec).await
    }

    async fn start_on(docker: &Docker, spec: HelperSpec) -> anyhow::Result<Self> {
        ensure_image(docker, spec.image).await?;
        let mut labels = HashMap::from([(HELPER_LABEL.to_string(), HELPER_KIND.to_string())]);
        if let Some((volume, _)) = &spec.volume {
            labels.insert("harbor.volume".into(), volume.clone());
        }
        let created = docker
            .create_container(
                Some(CreateContainerOptions::default()),
                ContainerCreateBody {
                    image: Some(spec.image.into()),
                    // The rclone image's entrypoint is rclone itself.
                    entrypoint: Some(vec!["sleep".into()]),
                    cmd: Some(vec!["infinity".into()]),
                    labels: Some(labels),
                    network_disabled: Some(!spec.network),
                    host_config: Some(HostConfig {
                        mounts: spec.volume.map(|(volume, read_only)| {
                            vec![Mount {
                                target: Some("/vol".into()),
                                source: Some(volume),
                                typ: Some(MountType::VOLUME),
                                read_only: Some(read_only),
                                ..Default::default()
                            }]
                        }),
                        network_mode: (!spec.network).then(|| "none".into()),
                        auto_remove: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await?;
        let helper = Self { docker: docker.clone(), id: created.id };
        docker.start_container(&helper.id, None::<StartContainerOptions>).await?;
        Ok(helper)
    }

    /// Runs `cmd`, feeding `stdin` from a file and writing stdout to `stdout`
    /// if given (otherwise up to 1 MB of it is returned). Returns (stdout,
    /// stderr, exit code).
    pub async fn exec(
        &self,
        cmd: Vec<String>,
        env: Vec<String>,
        stdin: Option<tokio::fs::File>,
        mut stdout: Option<tokio::fs::File>,
    ) -> anyhow::Result<(Vec<u8>, String, i64)> {
        let exec = self
            .docker
            .create_exec(
                &self.id,
                ExecConfig {
                    cmd: Some(cmd),
                    env: Some(env),
                    attach_stdin: Some(stdin.is_some()),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    ..Default::default()
                },
            )
            .await?;
        let StartExecResults::Attached { mut output, mut input } = self.docker.start_exec(&exec.id, None).await? else {
            bail!("the helper didn't attach");
        };
        let feed = async move {
            if let Some(mut file) = stdin {
                // The command may exit early (e.g. a bad archive); its exit
                // code reports that, so a broken pipe here isn't the error.
                let _ = tokio::io::copy(&mut file, &mut input).await;
            }
            // Closing our side delivers EOF to the command's stdin.
            let _ = input.shutdown().await;
        };
        let collect = async {
            let mut out = Vec::new();
            let mut err = String::new();
            while let Some(chunk) = output.next().await {
                match chunk? {
                    LogOutput::StdOut { message } => match stdout.as_mut() {
                        Some(file) => file.write_all(&message).await?,
                        None if out.len() < MAX_CAPTURE => out.extend_from_slice(&message),
                        None => {}
                    },
                    LogOutput::StdErr { message } if err.len() < MAX_CAPTURE => err.push_str(&String::from_utf8_lossy(&message)),
                    _ => {}
                }
            }
            if let Some(file) = stdout.as_mut() {
                file.flush().await?;
            }
            anyhow::Ok((out, err))
        };
        let ((), collected) = tokio::join!(feed, collect);
        let (out, err) = collected?;
        let code = self.docker.inspect_exec(&exec.id).await?.exit_code.unwrap_or(0);
        Ok((out, err, code))
    }
}

/// Removes helpers and temporary files left by a previous run, and starts
/// the scheduler.
pub async fn init(state: &AppState) {
    let leftovers = state
        .docker
        .list_containers(Some(ListContainersOptions {
            all: true,
            filters: Some(HashMap::from([("label".to_string(), vec![format!("{HELPER_LABEL}={HELPER_KIND}")])])),
            ..Default::default()
        }))
        .await
        .unwrap_or_default();
    for c in leftovers {
        if let Some(id) = c.id {
            let _ = state.docker.remove_container(&id, Some(RemoveContainerOptions { force: true, ..Default::default() })).await;
        }
    }
    let tmp = tmp_dir(state);
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    if let Err(e) = tokio::fs::create_dir_all(&tmp).await {
        tracing::warn!("creating {}: {e}", tmp.display());
    }
    spawn_scheduler(state.clone());
}

fn tmp_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("backups").join("tmp")
}

/// A file in the temporary folder, deleted when dropped.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

// ---- Stopping containers around a backup or restore --------------------------

/// Running containers (other than Harbor's helpers) that mount `volume`.
async fn running_users(docker: &Docker, volume: &str) -> anyhow::Result<Vec<(String, String)>> {
    let containers = docker
        .list_containers(Some(ListContainersOptions {
            filters: Some(HashMap::from([
                ("volume".to_string(), vec![volume.to_string()]),
                ("status".to_string(), vec!["running".to_string()]),
            ])),
            ..Default::default()
        }))
        .await?;
    Ok(containers
        .into_iter()
        .filter(|c| !crate::volume_browser::is_helper(c))
        .filter_map(|c| {
            let name = c.names.as_ref().and_then(|n| n.first()).map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default();
            c.id.map(|id| (id, name))
        })
        .collect())
}

async fn stop_all(docker: &Docker, log: &UpdateLog, containers: &[(String, String)]) -> anyhow::Result<()> {
    for (id, name) in containers {
        log.line(format!("stopping {name}")).await;
        docker.stop_container(id, None::<StopContainerOptions>).await.with_context(|| format!("stopping {name}"))?;
    }
    Ok(())
}

/// Starts the containers again, reporting every failure rather than the first.
async fn start_all(docker: &Docker, log: &UpdateLog, containers: &[(String, String)]) -> anyhow::Result<()> {
    let mut failed = Vec::new();
    for (id, name) in containers {
        log.line(format!("starting {name}")).await;
        if let Err(e) = docker.start_container(id, None::<StartContainerOptions>).await {
            log.line(format!("couldn't start {name}: {e}")).await;
            failed.push(name.clone());
        }
    }
    if !failed.is_empty() {
        bail!("couldn't start {} again", failed.join(", "));
    }
    Ok(())
}

/// Runs `work` with the volume's containers stopped (if `stop`), starting them
/// again afterwards whatever happened. Not cancellable meanwhile, so a cancel
/// can't leave services down.
async fn with_stopped<T>(
    state: &AppState,
    log: &UpdateLog,
    volume: &str,
    stop: bool,
    work: impl Future<Output = anyhow::Result<T>>,
) -> anyhow::Result<T> {
    if !stop {
        return work.await;
    }
    let _guard = log.no_cancel()?;
    let containers = running_users(&state.docker, volume).await?;
    if containers.is_empty() {
        log.line("no running containers use this volume").await;
    }
    if let Err(e) = stop_all(&state.docker, log, &containers).await {
        start_all(&state.docker, log, &containers).await.ok();
        return Err(e);
    }
    let result = work.await;
    let restarted = start_all(&state.docker, log, &containers).await;
    let value = result?;
    restarted?;
    Ok(value)
}

// ---- Backing up --------------------------------------------------------------

/// Archives the volume into `to` as a gzipped tarball of its contents.
async fn archive(state: &AppState, volume: &str, to: &FsPath) -> anyhow::Result<u64> {
    let helper = Helper::start(state, HelperSpec::volume(volume, true)).await?;
    let out = tokio::fs::File::create(to).await.with_context(|| format!("creating {}", to.display()))?;
    let cmd = ["tar", "-czf", "-", "-C", "/vol", "."].map(String::from).to_vec();
    let (_, stderr, code) = helper.exec(cmd, vec![], None, Some(out)).await?;
    if code != 0 {
        bail!("tar exited with {code}: {}", stderr.trim());
    }
    Ok(tokio::fs::metadata(to).await?.len())
}

fn archive_name(volume: &str) -> String {
    format!("{volume}-{}.tar.gz", chrono::Utc::now().format("%Y%m%d-%H%M%S"))
}

#[derive(Clone, sqlx::FromRow)]
struct JobRow {
    id: i64,
    volume: String,
    destination_id: i64,
    schedule: String,
    keep: i64,
    stop_containers: bool,
    last_update_id: Option<i64>,
}

/// Starts a backup of `volume` to `dest` as an update. With a job, the job's
/// retention applies afterwards.
async fn start_backup(
    state: &AppState,
    user: &User,
    volume: &str,
    dest: Destination,
    job: Option<JobRow>,
    stop_containers: bool,
) -> AppResult<Update> {
    let st = state.clone();
    let vol = volume.to_string();
    let job_id = job.as_ref().map(|j| j.id);
    let update = updates::spawn(state, user, "volume", volume, "backup", move |log| async move {
        let lock = st.lock_for(&format!("volume:{vol}"));
        let _guard = lock.lock().await;
        log.set_detail(&format!("to {}", dest.name)).await;
        // Mounting a missing volume would create an empty one, and retention
        // would then replace good backups with empty ones.
        st.docker.inspect_volume(&vol).await.with_context(|| format!("volume {vol} doesn't exist anymore"))?;
        let name = archive_name(&vol);
        log.line(format!("backing up volume {vol} to {} ({})", dest.name, kind_label(&dest.kind))).await;

        let tmp = TempFile(tmp_dir(&st).join(&name));
        tokio::fs::create_dir_all(tmp_dir(&st)).await?;
        log.line("archiving the volume").await;
        let size = with_stopped(&st, &log, &vol, stop_containers, archive(&st, &vol, &tmp.0)).await?;
        log.line(format!("archive {name} is {}", human(size))).await;

        let remote_ref = dest.upload(&st, &tmp.0, &name, &log).await?;
        drop(tmp);
        sqlx::query(
            "INSERT INTO backups (volume, job_id, destination_id, file_name, remote_ref, size, update_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&vol)
        .bind(job_id)
        .bind(dest.id)
        .bind(&name)
        .bind(&remote_ref)
        .bind(size as i64)
        .bind(log.id())
        .bind(now())
        .execute(&st.db)
        .await?;

        if let Some(job) = job.filter(|j| j.keep > 0) {
            prune(&st, &log, &dest, &job).await;
        }
        log.line("backup complete").await;
        Ok(())
    })
    .await?;
    if let Some(id) = job_id {
        sqlx::query("UPDATE backup_jobs SET last_update_id = ? WHERE id = ?").bind(update.id).bind(id).execute(&state.db).await?;
    }
    Ok(update)
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "gdrive" => "Google Drive",
        "local" => "local folder",
        "rclone" => "rclone",
        _ => "unknown",
    }
}

/// Deletes the job's backups beyond the newest `keep`. Failures are logged,
/// not fatal: the new backup is safe either way.
async fn prune(state: &AppState, log: &UpdateLog, dest: &Destination, job: &JobRow) {
    let old = sqlx::query_as::<_, BackupRow>(
        "SELECT b.*, d.name AS destination_name, d.kind AS destination_kind FROM backups b
         LEFT JOIN backup_destinations d ON d.id = b.destination_id
         WHERE b.job_id = ? AND b.destination_id = ? ORDER BY b.id DESC LIMIT -1 OFFSET ?",
    )
    .bind(job.id)
    .bind(dest.id)
    .bind(job.keep)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for b in old {
        match dest.delete(state, &b.remote_ref).await {
            Ok(()) => {
                let _ = sqlx::query("DELETE FROM backups WHERE id = ?").bind(b.id).execute(&state.db).await;
                log.line(format!("deleted old backup {}", b.file_name)).await;
            }
            Err(e) => log.line(format!("couldn't delete old backup {}: {e:#}", b.file_name)).await,
        }
    }
}

// ---- Restoring ---------------------------------------------------------------

/// Extracts into a staging folder first, so a corrupt or truncated archive
/// fails before anything in the volume is touched; then swaps it in.
const RESTORE_SCRIPT: &str = r#"set -e
staging=/vol/.harbor-restore
rm -rf "$staging"
mkdir "$staging"
if ! tar -xzf - -C "$staging"; then rm -rf "$staging"; echo "the archive couldn't be extracted; the volume was left as it was" >&2; exit 1; fi
find /vol -mindepth 1 -maxdepth 1 ! -name .harbor-restore -exec rm -rf {} +
find "$staging" -mindepth 1 -maxdepth 1 -exec mv {} /vol/ \;
rmdir "$staging"
"#;

async fn restore_into(state: &AppState, volume: &str, archive: &FsPath) -> anyhow::Result<()> {
    let helper = Helper::start(state, HelperSpec::volume(volume, false)).await?;
    let input = tokio::fs::File::open(archive).await?;
    let cmd = vec!["sh".into(), "-c".into(), RESTORE_SCRIPT.into()];
    let (_, stderr, code) = helper.exec(cmd, vec![], Some(input), None).await?;
    if code != 0 {
        bail!("restore failed: {}", stderr.trim());
    }
    Ok(())
}

#[derive(Deserialize)]
struct RestoreInput {
    /// Defaults to the volume that was backed up; created if it doesn't exist.
    #[serde(default)]
    volume: String,
    #[serde(default)]
    stop_containers: bool,
}

async fn restore(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<i64>,
    Json(input): Json<RestoreInput>,
) -> AppResult<Json<Update>> {
    let backup = get_backup(&state, id).await?;
    let dest_id = backup.destination_id.ok_or_else(|| AppError::conflict("this backup's destination was removed"))?;
    let dest = get_destination(&state.db, dest_id).await?;
    let volume = match input.volume.trim() {
        "" => backup.volume.clone(),
        v => v.to_string(),
    };
    if !volume.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        || !volume.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err(AppError::bad_request("invalid volume name"));
    }
    let st = state.clone();
    let target = volume.clone();
    let update = updates::spawn(&state, &user, "volume", &target, "restore", move |log| async move {
        let lock = st.lock_for(&format!("volume:{volume}"));
        let _guard = lock.lock().await;
        log.set_detail(&backup.file_name).await;
        log.line(format!("restoring {} from {} into volume {volume}", backup.file_name, dest.name)).await;
        tokio::fs::create_dir_all(tmp_dir(&st)).await?;
        let tmp = TempFile(tmp_dir(&st).join(format!("restore-{}-{}", backup.id, backup.file_name)));
        log.line("downloading the backup").await;
        dest.download(&st, &backup.remote_ref, &tmp.0).await?;
        log.line(format!("downloaded {}", human(tokio::fs::metadata(&tmp.0).await?.len()))).await;
        if st.docker.inspect_volume(&volume).await.is_err() {
            log.line(format!("creating volume {volume}")).await;
            st.docker
                .create_volume(bollard::models::VolumeCreateRequest { name: Some(volume.clone()), ..Default::default() })
                .await?;
        }
        // The read-only browser helper would show stale files.
        crate::volume_browser::release(&st, &volume).await;
        log.line("replacing the volume's contents").await;
        with_stopped(&st, &log, &volume, input.stop_containers, restore_into(&st, &volume, &tmp.0)).await?;
        log.line("restore complete").await;
        Ok(())
    })
    .await?;
    Ok(Json(update))
}

// ---- Backups API -------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
struct BackupRow {
    id: i64,
    volume: String,
    job_id: Option<i64>,
    destination_id: Option<i64>,
    destination_name: Option<String>,
    destination_kind: Option<String>,
    file_name: String,
    #[serde(skip)]
    remote_ref: String,
    size: i64,
    update_id: Option<i64>,
    created_at: String,
}

async fn get_backup(state: &AppState, id: i64) -> AppResult<BackupRow> {
    sqlx::query_as::<_, BackupRow>(
        "SELECT b.*, d.name AS destination_name, d.kind AS destination_kind FROM backups b
         LEFT JOIN backup_destinations d ON d.id = b.destination_id WHERE b.id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("backup not found"))
}

#[derive(Deserialize)]
struct VolumeQuery {
    volume: Option<String>,
}

async fn list_backups(State(state): State<AppState>, Query(q): Query<VolumeQuery>) -> AppResult<Json<Vec<BackupRow>>> {
    Ok(Json(
        sqlx::query_as::<_, BackupRow>(
            "SELECT b.*, d.name AS destination_name, d.kind AS destination_kind FROM backups b
             LEFT JOIN backup_destinations d ON d.id = b.destination_id
             WHERE (?1 IS NULL OR b.volume = ?1) ORDER BY b.id DESC LIMIT 500",
        )
        .bind(q.volume)
        .fetch_all(&state.db)
        .await?,
    ))
}

/// Deletes the backup from its destination and forgets it.
async fn delete_backup(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let backup = get_backup(&state, id).await?;
    if let Some(dest_id) = backup.destination_id {
        let dest = get_destination(&state.db, dest_id).await?;
        dest.delete(&state, &backup.remote_ref).await?;
    }
    sqlx::query("DELETE FROM backups WHERE id = ?").bind(id).execute(&state.db).await?;
    Ok(Json(json!({ "deleted": id })))
}

#[derive(Deserialize)]
struct RunOnceInput {
    destination_id: i64,
    #[serde(default)]
    stop_containers: bool,
}

/// A one-off backup outside any schedule (not subject to retention).
async fn run_once(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path(volume): Path<String>,
    Json(input): Json<RunOnceInput>,
) -> AppResult<Json<Update>> {
    state.docker.inspect_volume(&volume).await?;
    let dest = get_destination(&state.db, input.destination_id).await?;
    Ok(Json(start_backup(&state, &user, &volume, dest, None, input.stop_containers).await?))
}

// ---- Jobs --------------------------------------------------------------------

/// Next time `schedule` fires after now, as stored (UTC, like `now()`).
fn next_run(schedule: &str) -> anyhow::Result<String> {
    let cron = croner::Cron::from_str(schedule).map_err(|e| anyhow::anyhow!("invalid schedule: {e}"))?;
    let next = cron
        .find_next_occurrence(&chrono::Local::now(), false)
        .map_err(|e| anyhow::anyhow!("schedule never fires: {e}"))?;
    Ok(next.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

#[derive(Deserialize)]
struct ScheduleQuery {
    cron: String,
}

/// Describes a schedule and its next few runs, for the editor.
async fn preview_schedule(Query(q): Query<ScheduleQuery>) -> AppResult<Json<Value>> {
    let cron = croner::Cron::from_str(q.cron.trim()).map_err(|e| AppError::bad_request(format!("invalid schedule: {e}")))?;
    let mut next = Vec::new();
    let mut from = chrono::Local::now();
    for _ in 0..3 {
        match cron.find_next_occurrence(&from, false) {
            Ok(t) => {
                next.push(t.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                from = t;
            }
            Err(_) => break,
        }
    }
    Ok(Json(json!({ "description": cron.describe(), "next": next, "timezone": chrono::Local::now().format("UTC%:z").to_string() })))
}

#[derive(Serialize, sqlx::FromRow)]
struct JobView {
    id: i64,
    volume: String,
    destination_id: i64,
    destination_name: String,
    destination_kind: String,
    schedule: String,
    keep: i64,
    stop_containers: bool,
    enabled: bool,
    next_run_at: Option<String>,
    last_update_id: Option<i64>,
    last_status: Option<String>,
    last_run_at: Option<String>,
    created_at: String,
}

const JOB_VIEW: &str = "SELECT j.*, d.name AS destination_name, d.kind AS destination_kind,
        u.status AS last_status, u.started_at AS last_run_at
    FROM backup_jobs j
    JOIN backup_destinations d ON d.id = j.destination_id
    LEFT JOIN updates u ON u.id = j.last_update_id";

async fn job_view(state: &AppState, id: i64) -> AppResult<JobView> {
    sqlx::query_as::<_, JobView>(sqlx::AssertSqlSafe(format!("{JOB_VIEW} WHERE j.id = ?")))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("backup job not found"))
}

async fn list_jobs(State(state): State<AppState>, Query(q): Query<VolumeQuery>) -> AppResult<Json<Vec<JobView>>> {
    Ok(Json(
        sqlx::query_as::<_, JobView>(sqlx::AssertSqlSafe(format!("{JOB_VIEW} WHERE (?1 IS NULL OR j.volume = ?1) ORDER BY j.volume, j.id")))
            .bind(q.volume)
            .fetch_all(&state.db)
            .await?,
    ))
}

#[derive(Deserialize)]
struct JobInput {
    volume: String,
    destination_id: i64,
    schedule: String,
    #[serde(default = "default_keep")]
    keep: i64,
    #[serde(default)]
    stop_containers: bool,
    #[serde(default = "default_true")]
    enabled: bool,
}

fn default_keep() -> i64 {
    7
}

fn default_true() -> bool {
    true
}

async fn check_job(state: &AppState, input: &JobInput) -> AppResult<Option<String>> {
    get_destination(&state.db, input.destination_id).await?;
    if !(0..=1000).contains(&input.keep) {
        return Err(AppError::bad_request("keep must be between 0 (keep all) and 1000"));
    }
    let next = next_run(input.schedule.trim()).map_err(|e| AppError::bad_request(e.to_string()))?;
    Ok(input.enabled.then_some(next))
}

async fn create_job(State(state): State<AppState>, Json(input): Json<JobInput>) -> AppResult<Json<JobView>> {
    state.docker.inspect_volume(&input.volume).await?;
    let next = check_job(&state, &input).await?;
    let id = sqlx::query(
        "INSERT INTO backup_jobs (volume, destination_id, schedule, keep, stop_containers, enabled, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&input.volume)
    .bind(input.destination_id)
    .bind(input.schedule.trim())
    .bind(input.keep)
    .bind(input.stop_containers)
    .bind(input.enabled)
    .bind(next)
    .bind(now())
    .execute(&state.db)
    .await?
    .last_insert_rowid();
    Ok(Json(job_view(&state, id).await?))
}

async fn update_job(State(state): State<AppState>, Path(id): Path<i64>, Json(input): Json<JobInput>) -> AppResult<Json<JobView>> {
    let next = check_job(&state, &input).await?;
    let updated = sqlx::query(
        "UPDATE backup_jobs SET destination_id = ?, schedule = ?, keep = ?, stop_containers = ?, enabled = ?, next_run_at = ?
         WHERE id = ?",
    )
    .bind(input.destination_id)
    .bind(input.schedule.trim())
    .bind(input.keep)
    .bind(input.stop_containers)
    .bind(input.enabled)
    .bind(next)
    .bind(id)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::not_found("backup job not found"));
    }
    Ok(Json(job_view(&state, id).await?))
}

/// Deletes the schedule; its backups are kept.
async fn delete_job(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    sqlx::query("DELETE FROM backup_jobs WHERE id = ?").bind(id).execute(&state.db).await?;
    Ok(Json(json!({ "deleted": id })))
}

async fn get_job(state: &AppState, id: i64) -> AppResult<JobRow> {
    sqlx::query_as::<_, JobRow>("SELECT * FROM backup_jobs WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("backup job not found"))
}

async fn run_job(State(state): State<AppState>, Extension(user): Extension<User>, Path(id): Path<i64>) -> AppResult<Json<Update>> {
    let job = get_job(&state, id).await?;
    Ok(Json(run(&state, &user, job).await?))
}

async fn run(state: &AppState, user: &User, job: JobRow) -> AppResult<Update> {
    let dest = get_destination(&state.db, job.destination_id).await?;
    let (volume, stop) = (job.volume.clone(), job.stop_containers);
    start_backup(state, user, &volume, dest, Some(job), stop).await
}

/// Every 30 seconds, starts the backups that are due. A run missed while
/// Harbor was down happens once at startup.
fn spawn_scheduler(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            if let Err(e) = run_due(&state).await {
                tracing::warn!("backup scheduler: {e:#}");
            }
        }
    });
}

async fn run_due(state: &AppState) -> anyhow::Result<()> {
    let due = sqlx::query_as::<_, JobRow>(
        "SELECT * FROM backup_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?",
    )
    .bind(now())
    .fetch_all(&state.db)
    .await?;
    for job in due {
        let next = next_run(&job.schedule).ok();
        sqlx::query("UPDATE backup_jobs SET next_run_at = ? WHERE id = ?").bind(&next).bind(job.id).execute(&state.db).await?;
        let still_running = match job.last_update_id {
            Some(id) => sqlx::query_scalar::<_, String>("SELECT status FROM updates WHERE id = ?")
                .bind(id)
                .fetch_optional(&state.db)
                .await?
                .is_some_and(|s| s == "running"),
            None => false,
        };
        if still_running {
            tracing::info!("skipping backup of {}: the previous run is still going", job.volume);
            continue;
        }
        tracing::info!("starting scheduled backup of {}", job.volume);
        let volume = job.volume.clone();
        if let Err(e) = run(state, &system_user("schedule"), job).await {
            tracing::warn!("scheduled backup of {volume} didn't start: {}", e.message);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_next_runs() {
        let next = next_run("0 3 * * *").unwrap();
        assert!(next > now());
        assert!(next_run("not a schedule").is_err());
        assert!(next_run("@daily").is_ok());
    }

    /// Needs a Docker engine: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn exec_delivers_stdin_eof() {
        let docker = Docker::connect_with_local_defaults().unwrap();
        let helper = Helper::start_on(&docker, HelperSpec { image: ARCHIVE_IMAGE, volume: None, network: false }).await.unwrap();
        let path = std::env::temp_dir().join("harbor-eof-test");
        tokio::fs::write(&path, vec![b'x'; 70_000]).await.unwrap();
        let input = tokio::fs::File::open(&path).await.unwrap();
        let cmd = vec!["wc".into(), "-c".into()];
        let (out, _, code) = tokio::time::timeout(Duration::from_secs(20), helper.exec(cmd, vec![], Some(input), None)).await.unwrap().unwrap();
        assert_eq!((String::from_utf8_lossy(&out).trim(), code), ("70000", 0));
    }

    #[test]
    fn names_archives_by_volume_and_time() {
        let name = archive_name("pg_data");
        assert!(name.starts_with("pg_data-") && name.ends_with(".tar.gz"));
    }
}
