//! Deployments are single containers. Their image either comes from a
//! registry (pulled on deploy) or is built from a git repository's
//! Dockerfile. Deploying (re)creates a container named after the deployment.

use std::collections::HashMap;

use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use bollard::{
    Docker,
    models::{
        ContainerCreateBody, ContainerInspectResponse, HostConfig, PortBinding, PortMap, RestartPolicy,
        RestartPolicyNameEnum,
    },
    query_parameters::*,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value, json};

use crate::{
    auth::User,
    error::{AppError, AppResult},
    git,
    state::{AppState, now, validate_name},
    updates::{self, Update, UpdateLog},
};

const LABEL: &str = "harbor.deployment";

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Deployment {
    pub id: i64,
    pub name: String,
    /// For git deployments, the most recently built image tag.
    pub image: String,
    pub ports: String,
    pub env: String,
    pub volumes: String,
    pub network: String,
    pub restart: String,
    pub command: String,
    pub created_at: String,
    pub updated_at: String,
    /// "image" or "git".
    pub source: String,
    pub git_url: String,
    pub git_branch: String,
    pub build_context: String,
    pub dockerfile: String,
    pub build_args: String,
    /// Never sent to clients; serialized only as whether one is set.
    #[serde(rename = "has_token", serialize_with = "is_set")]
    pub git_token: String,
    pub auto_deploy: bool,
    pub webhook_secret: String,
    pub last_commit: String,
    pub last_commit_message: String,
    pub last_seen_commit: String,
    /// Name of a container this deployment took over on import. It keeps
    /// running until the first deploy replaces it.
    pub adopted_container: String,
    /// Extra container labels, `KEY=value` per line.
    pub labels: String,
    pub pinned: bool,
    pub group_id: Option<i64>,
    /// Git account for the repository; None picks the one for its host.
    pub git_account_id: Option<i64>,
}

impl Deployment {
    /// Token for the repository (account, else the legacy per-service token).
    async fn token(&self, db: &sqlx::SqlitePool) -> String {
        crate::accounts::resolve_token(db, &self.git_url, self.git_account_id, &self.git_token).await
    }
}

fn is_set<S: Serializer>(value: &str, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_bool(!value.is_empty())
}

/// The runtime settings a deploy ran with, stored on its update so a
/// rollback restores them along with the image.
#[derive(Serialize, Deserialize)]
struct Snapshot {
    image: String,
    ports: String,
    env: String,
    volumes: String,
    network: String,
    restart: String,
    command: String,
    #[serde(default)]
    labels: String,
}

impl Snapshot {
    fn of(d: &Deployment) -> Self {
        Self {
            image: d.image.clone(),
            ports: d.ports.clone(),
            env: d.env.clone(),
            volumes: d.volumes.clone(),
            network: d.network.clone(),
            restart: d.restart.clone(),
            command: d.command.clone(),
            labels: d.labels.clone(),
        }
    }

    fn json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[derive(Deserialize)]
struct DeploymentInput {
    name: Option<String>,
    #[serde(default = "default_source")]
    source: String,
    #[serde(default)]
    image: String,
    #[serde(default)]
    ports: String,
    #[serde(default)]
    env: String,
    #[serde(default)]
    volumes: String,
    #[serde(default)]
    network: String,
    #[serde(default = "default_restart")]
    restart: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    git_url: String,
    /// Empty means the repository's default branch.
    #[serde(default)]
    git_branch: String,
    #[serde(default = "default_context")]
    build_context: String,
    #[serde(default = "default_dockerfile")]
    dockerfile: String,
    #[serde(default)]
    build_args: String,
    /// Absent keeps the stored token, "" clears it, anything else replaces it.
    git_token: Option<String>,
    #[serde(default)]
    auto_deploy: bool,
    #[serde(default)]
    labels: String,
    #[serde(default)]
    git_account_id: Option<i64>,
}

fn default_source() -> String {
    "image".into()
}
fn default_restart() -> String {
    "unless-stopped".into()
}
fn default_context() -> String {
    ".".into()
}
fn default_dockerfile() -> String {
    "Dockerfile".into()
}

#[derive(Serialize)]
struct DeploymentWithStatus {
    #[serde(flatten)]
    deployment: Deployment,
    /// Docker container state ("running", "exited", ...) or "not_deployed".
    status: String,
    container_id: Option<String>,
    container_image: Option<String>,
}

#[derive(Serialize)]
struct DeploymentDetail {
    #[serde(flatten)]
    deployment: Deployment,
    status: String,
    container: Option<ContainerInspectResponse>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{name}", get(detail).put(update).delete(remove))
        .route("/{name}/rollback/{update_id}", post(rollback))
        .route("/{name}/{action}", post(action))
}

/// Unauthenticated routes; requests are verified by signature instead.
pub fn webhook_router() -> Router<AppState> {
    Router::new()
        .route("/github/{name}", post(github_webhook))
        // GitHub sends push payloads up to 25 MB.
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
}

async fn fetch(state: &AppState, name: &str) -> AppResult<Deployment> {
    sqlx::query_as::<_, Deployment>("SELECT * FROM deployments WHERE name = ?")
        .bind(name)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found(format!("deployment '{name}' not found")))
}

async fn find_container(docker: &Docker, name: &str) -> AppResult<Option<ContainerInspectResponse>> {
    match docker.inspect_container(name, None).await {
        Ok(c) => Ok(Some(c)),
        Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The deployment's container: its own, or the one it adopted on import.
async fn deployment_container(docker: &Docker, d: &Deployment) -> AppResult<Option<ContainerInspectResponse>> {
    if let Some(c) = find_container(docker, &d.name).await? {
        return Ok(Some(c));
    }
    if d.adopted_container.is_empty() {
        return Ok(None);
    }
    find_container(docker, &d.adopted_container).await
}

/// Name to address the deployment's running container by.
async fn container_name(docker: &Docker, d: &Deployment) -> String {
    match deployment_container(docker, d).await {
        Ok(Some(c)) => c.name.map(|n| n.trim_start_matches('/').to_string()).unwrap_or_else(|| d.name.clone()),
        _ => d.name.clone(),
    }
}

fn container_status(c: &Option<ContainerInspectResponse>) -> String {
    c.as_ref()
        .and_then(|c| c.state.as_ref())
        .and_then(|s| s.status)
        .map(|s| s.to_string())
        .unwrap_or_else(|| "not_deployed".into())
}

async fn list(State(state): State<AppState>) -> AppResult<Json<Vec<DeploymentWithStatus>>> {
    let deployments = sqlx::query_as::<_, Deployment>("SELECT * FROM deployments ORDER BY name")
        .fetch_all(&state.db)
        .await?;
    // All containers, since imported ones don't carry Harbor's label yet.
    let containers = state
        .docker
        .list_containers(Some(ListContainersOptions { all: true, ..Default::default() }))
        .await
        .unwrap_or_default();
    let items = deployments
        .into_iter()
        .map(|deployment| {
            let has_name = |c: &bollard::models::ContainerSummary, name: &str| {
                !name.is_empty() && c.names.as_ref().is_some_and(|n| n.iter().any(|n| n.trim_start_matches('/') == name))
            };
            let c = containers
                .iter()
                .find(|c| c.labels.as_ref().and_then(|l| l.get(LABEL)).is_some_and(|n| *n == deployment.name))
                .or_else(|| containers.iter().find(|c| has_name(c, &deployment.name)))
                .or_else(|| containers.iter().find(|c| has_name(c, &deployment.adopted_container)));
            DeploymentWithStatus {
                status: c
                    .and_then(|c| c.state)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "not_deployed".into()),
                container_id: c.and_then(|c| c.id.clone()),
                container_image: c.and_then(|c| c.image.clone()),
                deployment,
            }
        })
        .collect();
    Ok(Json(items))
}

async fn detail(State(state): State<AppState>, Path(name): Path<String>) -> AppResult<Json<DeploymentDetail>> {
    let deployment = fetch(&state, &name).await?;
    let container = deployment_container(&state.docker, &deployment).await?;
    Ok(Json(DeploymentDetail {
        status: container_status(&container),
        container,
        deployment,
    }))
}

/// Fills in the default branch when a git deployment doesn't name one.
async fn resolve_branch(state: &AppState, input: &mut DeploymentInput, stored_token: &str) -> AppResult<()> {
    if input.source != "git" {
        return Ok(());
    }
    let url = git::normalize_url(&input.git_url);
    let fallback = input.git_token.as_deref().unwrap_or(stored_token);
    let token = crate::accounts::resolve_token(&state.db, &url, input.git_account_id, fallback).await;
    input.git_branch = git::resolve_branch(&url, &input.git_branch, &token).await.map_err(AppError::bad_request)?;
    Ok(())
}

fn validate(input: &mut DeploymentInput) -> AppResult<()> {
    match input.source.as_str() {
        "image" => {
            if input.image.trim().is_empty() {
                return Err(AppError::bad_request("image is required"));
            }
        }
        "git" => {
            input.git_url = git::normalize_url(&input.git_url);
            input.git_branch = input.git_branch.trim().to_string();
            if input.git_url.is_empty() || input.git_url.starts_with('-') {
                return Err(AppError::bad_request("repository URL is required"));
            }
            if input.git_branch.is_empty() || input.git_branch.starts_with('-') || input.git_branch.contains(char::is_whitespace) {
                return Err(AppError::bad_request("invalid branch name"));
            }
            git::validate_rel_path(&input.build_context, "root directory").map_err(AppError::bad_request)?;
            git::validate_rel_path(&input.dockerfile, "Dockerfile path").map_err(AppError::bad_request)?;
        }
        other => return Err(AppError::bad_request(format!("unknown source '{other}'"))),
    }
    parse_restart(&input.restart)?;
    parse_ports(&input.ports)?;
    Ok(())
}

async fn create(State(state): State<AppState>, Json(mut input): Json<DeploymentInput>) -> AppResult<Json<Deployment>> {
    let name = input.name.clone().unwrap_or_default();
    validate_name(&name)?;
    resolve_branch(&state, &mut input, "").await?;
    validate(&mut input)?;
    let ts = now();
    let d = sqlx::query_as::<_, Deployment>(
        "INSERT INTO deployments (name, image, ports, env, volumes, network, restart, command, created_at, updated_at,
           source, git_url, git_branch, build_context, dockerfile, build_args, git_token, auto_deploy, webhook_secret, labels, git_account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(&name)
    .bind(input.image.trim())
    .bind(&input.ports)
    .bind(&input.env)
    .bind(&input.volumes)
    .bind(input.network.trim())
    .bind(&input.restart)
    .bind(&input.command)
    .bind(&ts)
    .bind(&ts)
    .bind(&input.source)
    .bind(&input.git_url)
    .bind(&input.git_branch)
    .bind(input.build_context.trim())
    .bind(input.dockerfile.trim())
    .bind(&input.build_args)
    .bind(input.git_token.as_deref().unwrap_or("").trim())
    .bind(input.auto_deploy)
    .bind(hex::encode(rand::random::<[u8; 20]>()))
    .bind(&input.labels)
    .bind(input.git_account_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(d))
}

async fn update(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(mut input): Json<DeploymentInput>,
) -> AppResult<Json<Deployment>> {
    let existing = fetch(&state, &name).await?;
    resolve_branch(&state, &mut input, &existing.git_token).await?;
    validate(&mut input)?;
    let d = sqlx::query_as::<_, Deployment>(
        // A git deployment's image is set by its builds, not by the client.
        "UPDATE deployments SET
           image = CASE WHEN ?1 = 'git' THEN image ELSE ?2 END,
           ports = ?3, env = ?4, volumes = ?5, network = ?6, restart = ?7, command = ?8, updated_at = ?9,
           source = ?1, git_url = ?10, git_branch = ?11, build_context = ?12, dockerfile = ?13, build_args = ?14,
           git_token = COALESCE(?15, git_token), auto_deploy = ?16, labels = ?18, git_account_id = ?19
         WHERE name = ?17 RETURNING *",
    )
    .bind(&input.source)
    .bind(input.image.trim())
    .bind(&input.ports)
    .bind(&input.env)
    .bind(&input.volumes)
    .bind(input.network.trim())
    .bind(&input.restart)
    .bind(&input.command)
    .bind(now())
    .bind(&input.git_url)
    .bind(&input.git_branch)
    .bind(input.build_context.trim())
    .bind(input.dockerfile.trim())
    .bind(&input.build_args)
    .bind(input.git_token.as_deref().map(str::trim))
    .bind(input.auto_deploy)
    .bind(&name)
    .bind(&input.labels)
    .bind(input.git_account_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("deployment '{name}' not found")))?;
    Ok(Json(d))
}

async fn remove(State(state): State<AppState>, Path(name): Path<String>) -> AppResult<Json<Deployment>> {
    let d = fetch(&state, &name).await?;
    if deployment_container(&state.docker, &d).await?.is_some() {
        return Err(AppError::conflict(
            "deployment still has a container; destroy it before deleting",
        ));
    }
    sqlx::query("DELETE FROM deployments WHERE id = ?")
        .bind(d.id)
        .execute(&state.db)
        .await?;
    let checkout = state.builds_dir().join(&name);
    if checkout.exists() {
        tokio::fs::remove_dir_all(checkout).await.ok();
    }
    Ok(Json(d))
}

async fn action(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path((name, action)): Path<(String, String)>,
) -> AppResult<Json<Update>> {
    if !matches!(action.as_str(), "deploy" | "rebuild" | "pull" | "start" | "stop" | "restart" | "destroy") {
        return Err(AppError::bad_request(format!("unknown action '{action}'")));
    }
    let d = fetch(&state, &name).await?;
    Ok(Json(run_action(&state, &user, d, &action).await?))
}

/// Starts an action on a deployment as a tracked update. Actions on the same
/// deployment are serialized so overlapping deploys queue up.
pub async fn run_action(state: &AppState, user: &User, d: Deployment, action: &str) -> AppResult<Update> {
    run_op(state, user, d, action, None).await
}

async fn run_op(state: &AppState, user: &User, d: Deployment, action: &str, rollback_to: Option<Update>) -> AppResult<Update> {
    let op = action.to_string();
    let st = state.clone();
    // A rebuild is a deploy that always builds, and is recorded as one.
    let recorded = if action == "rebuild" { "deploy" } else { action };
    updates::spawn(state, user, "deployment", &d.name.clone(), recorded, move |log| async move {
        let lock = st.lock_for(&format!("deployment:{}", d.name));
        let _guard = match lock.try_lock() {
            Ok(g) => g,
            Err(_) => {
                log.line("waiting for the previous operation on this deployment to finish…").await;
                lock.lock().await
            }
        };
        // Re-read so a queued deploy uses the latest saved configuration.
        let d = sqlx::query_as::<_, Deployment>("SELECT * FROM deployments WHERE id = ?")
            .bind(d.id)
            .fetch_one(&st.db)
            .await?;
        let docker = &st.docker;
        let cname = container_name(docker, &d).await;
        match op.as_str() {
            "deploy" if d.source == "git" => build_and_deploy(&st, &log, &d, false).await,
            "rebuild" if d.source == "git" => {
                log.line("rebuilding, checking for newer base images").await;
                build_and_deploy(&st, &log, &d, true).await
            }
            "rebuild" => anyhow::bail!("only git deployments are built; deploy to pull the image again"),
            "deploy" => deploy_image(docker, &log, &d).await,
            "rollback" => roll_back(&st, &log, &d, rollback_to.expect("rollback target")).await,
            "pull" if d.source == "git" => anyhow::bail!("git deployments are built, not pulled; deploy to rebuild"),
            "pull" => pull(docker, &log, &d.image).await,
            "start" => Ok(docker.start_container(&cname, None::<StartContainerOptions>).await?),
            "stop" => Ok(docker.stop_container(&cname, None::<StopContainerOptions>).await?),
            "restart" => Ok(docker.restart_container(&cname, None::<RestartContainerOptions>).await?),
            "destroy" => destroy_all(docker, &log, &d).await,
            _ => unreachable!(),
        }?;
        // Once Harbor has created its own container, the imported one is gone.
        if matches!(op.as_str(), "deploy" | "rebuild" | "rollback" | "destroy") && !d.adopted_container.is_empty() {
            sqlx::query("UPDATE deployments SET adopted_container = '' WHERE id = ?")
                .bind(d.id)
                .execute(&st.db)
                .await?;
        }
        log.line(format!("{op} complete")).await;
        Ok(())
    })
    .await
}

/// Builds the branch head's Dockerfile into `harbor/<name>:<sha>` and deploys
/// it. When that commit was built before, its image is reused unless
/// `rebuild` is set, so redeploying after a settings change skips git and the
/// build. Rebuilds also check for newer base images.
async fn build_and_deploy(state: &AppState, log: &UpdateLog, d: &Deployment, rebuild: bool) -> anyhow::Result<()> {
    let repo = format!("harbor/{}", d.name);
    let token = d.token(&state.db).await;
    let tag_for = |sha: &str| format!("{repo}:{}", &sha[..sha.len().min(12)]);

    if !rebuild && let Some(commit) = built_head(state, log, d, &token, &tag_for).await {
        log.line(format!("{} \"{}\" is already built; reusing {} (rebuild to build it again)", commit.short(), commit.message, tag_for(&commit.sha))).await;
        return finish_git_deploy(state, log, d, &commit, &tag_for(&commit.sha)).await;
    }

    // The checkout is kept between builds, so later ones only fetch.
    let checkout = state.builds_dir().join(&d.name);
    let commit = match git::sync_checkout(log, &checkout, &d.git_url, &d.git_branch, &token).await {
        Ok(c) => c,
        // A broken checkout (e.g. an interrupted fetch) is replaced by a fresh clone.
        Err(e) if checkout.exists() => {
            log.line(format!("reusing the checkout failed ({e:#}); cloning again")).await;
            git::clone(log, &d.git_url, &d.git_branch, &token, &checkout).await?
        }
        Err(e) => return Err(e),
    };
    git::clean(log, &checkout).await?;
    log.line(format!("checked out {} \"{}\"", commit.short(), commit.message)).await;
    sqlx::query("UPDATE deployments SET last_seen_commit = ? WHERE id = ?")
        .bind(&commit.sha)
        .bind(d.id)
        .execute(&state.db)
        .await?;

    let tag = tag_for(&commit.sha);
    let build_args: Vec<String> = lines(&d.build_args).map(str::to_string).collect();
    // The label keeps builds out of "prune unused images" so they stay
    // available for rollback.
    let labels = [format!("{LABEL}={}", d.name)];
    git::build(log, &checkout, &d.build_context, &d.dockerfile, &build_args, &[tag.clone(), format!("{repo}:latest")], &labels, rebuild).await?;
    finish_git_deploy(state, log, d, &commit, &tag).await
}

/// The branch head, if its image was already built. Any failure just means
/// building as usual.
async fn built_head(
    state: &AppState,
    log: &UpdateLog,
    d: &Deployment,
    token: &str,
    tag_for: &impl Fn(&str) -> String,
) -> Option<git::Commit> {
    let head = tokio::time::timeout(std::time::Duration::from_secs(30), git::remote_head(&d.git_url, &d.git_branch, token)).await;
    let sha = match head {
        Ok(Ok(Some(sha))) => sha,
        Ok(Err(e)) => {
            log.line(format!("couldn't check the branch head ({e:#}); building")).await;
            return None;
        }
        _ => return None,
    };
    state.docker.inspect_image(&tag_for(&sha)).await.ok()?;
    // The commit message isn't in ls-remote: take it from the deploy that built it.
    let message = if d.last_commit == sha {
        d.last_commit_message.clone()
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT detail FROM updates WHERE target_type = 'deployment' AND target_name = ? AND artifact = ? AND detail != ''
             ORDER BY id DESC LIMIT 1",
        )
        .bind(&d.name)
        .bind(tag_for(&sha))
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|detail| detail.trim_start_matches("↩ ").split_once(' ').map(|(_, m)| m.to_string()))
        .unwrap_or_default()
    };
    Some(git::Commit { sha, message })
}

/// Runs a built commit's image and records it as the deployment's current one.
async fn finish_git_deploy(state: &AppState, log: &UpdateLog, d: &Deployment, commit: &git::Commit, tag: &str) -> anyhow::Result<()> {
    log.set_detail(&format!("{} {}", commit.short(), commit.message)).await;
    deploy(&state.docker, log, d, tag, false).await?;
    sqlx::query("UPDATE deployments SET image = ?, last_commit = ?, last_commit_message = ?, last_seen_commit = ? WHERE id = ?")
        .bind(tag)
        .bind(&commit.sha)
        .bind(&commit.message)
        .bind(&commit.sha)
        .bind(d.id)
        .execute(&state.db)
        .await?;
    let snapshot = Snapshot { image: tag.to_string(), ..Snapshot::of(d) };
    log.set_artifact(tag, &snapshot.json()).await;
    Ok(())
}

/// Pulls and deploys a registry image, recording the exact image ID so a
/// rollback isn't affected by the tag moving later.
async fn deploy_image(docker: &Docker, log: &UpdateLog, d: &Deployment) -> anyhow::Result<()> {
    deploy(docker, log, d, &d.image, true).await?;
    let id = docker.inspect_image(&d.image).await.ok().and_then(|i| i.id).unwrap_or_default();
    log.set_artifact(&id, &Snapshot::of(d).json()).await;
    Ok(())
}

/// Checks that `update` is a successful deploy of this deployment whose
/// image still exists, returning a user-facing error otherwise.
async fn rollback_target(state: &AppState, d: &Deployment, update_id: i64) -> AppResult<Update> {
    let u = sqlx::query_as::<_, Update>("SELECT * FROM updates WHERE id = ?")
        .bind(update_id)
        .fetch_optional(&state.db)
        .await?
        .filter(|u| u.target_type == "deployment" && u.target_name == d.name)
        .ok_or_else(|| AppError::not_found("deploy not found for this deployment"))?;
    if u.status != "success" || !matches!(u.operation.as_str(), "deploy" | "rollback") || u.snapshot.is_empty() || u.artifact.is_empty() {
        return Err(AppError::bad_request("only successful deploys made by this version of Harbor can be rolled back to"));
    }
    if state.docker.inspect_image(&u.artifact).await.is_err() {
        return Err(AppError::conflict(
            "the image for that deploy no longer exists (it was probably pruned); redeploy instead",
        ));
    }
    Ok(u)
}

async fn rollback(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path((name, update_id)): Path<(String, i64)>,
) -> AppResult<Json<Update>> {
    let d = fetch(&state, &name).await?;
    let target = rollback_target(&state, &d, update_id).await?;
    Ok(Json(run_op(&state, &user, d, "rollback", Some(target)).await?))
}

/// Restores a previous deploy's settings and runs its exact image again,
/// without building or pulling.
async fn roll_back(state: &AppState, log: &UpdateLog, d: &Deployment, target: Update) -> anyhow::Result<()> {
    // Re-check under the lock: the image may have been pruned meanwhile.
    if state.docker.inspect_image(&target.artifact).await.is_err() {
        anyhow::bail!("the image for that deploy no longer exists; redeploy instead");
    }
    let snapshot: Snapshot = serde_json::from_str(&target.snapshot)?;
    // Rolling back to a rollback: describe the deploy it restored.
    let detail = target.detail.trim_start_matches("↩ ");
    let label = if detail.is_empty() {
        format!("{} ({})", snapshot.image, short_image(&target.artifact))
    } else {
        detail.to_string()
    };
    log.line(format!("rolling back to deploy #{}: {label}", target.id)).await;
    log.set_detail(&format!("↩ {label}")).await;

    // Restore the settings first so the panel shows what's actually running.
    // For git deployments the commit moves back too, but `last_seen_commit`
    // stays put so the poller doesn't immediately redeploy the newer head.
    let (commit, message) = detail.split_once(' ').unwrap_or((detail, ""));
    sqlx::query(
        "UPDATE deployments SET image = ?, ports = ?, env = ?, volumes = ?, network = ?, restart = ?, command = ?, labels = ?, updated_at = ?,
           last_commit = CASE WHEN source = 'git' THEN ? ELSE last_commit END,
           last_commit_message = CASE WHEN source = 'git' THEN ? ELSE last_commit_message END
         WHERE id = ?",
    )
    .bind(&snapshot.image)
    .bind(&snapshot.ports)
    .bind(&snapshot.env)
    .bind(&snapshot.volumes)
    .bind(&snapshot.network)
    .bind(&snapshot.restart)
    .bind(&snapshot.command)
    .bind(&snapshot.labels)
    .bind(now())
    .bind(commit)
    .bind(message)
    .bind(d.id)
    .execute(&state.db)
    .await?;
    let restored = sqlx::query_as::<_, Deployment>("SELECT * FROM deployments WHERE id = ?")
        .bind(d.id)
        .fetch_one(&state.db)
        .await?;
    deploy(&state.docker, log, &restored, &target.artifact, false).await?;
    // Recorded like a deploy, so you can roll forward again.
    log.set_artifact(&target.artifact, &target.snapshot).await;
    Ok(())
}

fn short_image(image: &str) -> String {
    image.strip_prefix("sha256:").map(|id| id[..12.min(id.len())].to_string()).unwrap_or_else(|| image.to_string())
}

/// The image API pulls *every* tag when none is given, unlike the CLI which
/// defaults to `latest`.
fn with_default_tag(image: &str) -> String {
    let last = image.rsplit('/').next().unwrap_or(image);
    if last.contains(':') || last.contains('@') {
        image.to_string()
    } else {
        format!("{image}:latest")
    }
}

async fn pull(docker: &Docker, log: &UpdateLog, image: &str) -> anyhow::Result<()> {
    let image = with_default_tag(image);
    log.line(format!("pulling {image}")).await;
    let mut stream = docker.create_image(
        Some(CreateImageOptions {
            from_image: Some(image),
            ..Default::default()
        }),
        None,
        None,
    );
    while let Some(item) = stream.next().await {
        let info = item?;
        // Skip per-chunk progress noise; keep layer state transitions.
        if let Some(status) = info.status {
            if info.progress_detail.as_ref().is_some_and(|p| p.current.is_some()) {
                continue;
            }
            match info.id {
                Some(id) => log.line(format!("{id}: {status}")).await,
                None => log.line(status).await,
            }
        }
    }
    Ok(())
}

async fn destroy(docker: &Docker, log: &UpdateLog, name: &str) -> anyhow::Result<()> {
    match docker
        .remove_container(
            name,
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await
    {
        Ok(()) => log.line(format!("removed container {name}")).await,
        Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => {
            log.line("no existing container").await
        }
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

/// Removes the deployment's container and, if it was imported, the original.
async fn destroy_all(docker: &Docker, log: &UpdateLog, d: &Deployment) -> anyhow::Result<()> {
    destroy(docker, log, &d.name).await?;
    if !d.adopted_container.is_empty() && d.adopted_container != d.name {
        log.line(format!("replacing imported container {}", d.adopted_container)).await;
        destroy(docker, log, &d.adopted_container).await?;
    }
    Ok(())
}

/// Parses `KEY=value` lines into container labels.
fn parse_labels(s: &str) -> HashMap<String, String> {
    lines(s)
        .filter_map(|l| l.split_once('=').map(|(k, v)| (k.trim().to_string(), v.to_string())))
        .filter(|(k, _)| !k.is_empty())
        .collect()
}

/// (Re)creates the deployment's container from `image`, pulling it first
/// when `pull_first` is set.
async fn deploy(docker: &Docker, log: &UpdateLog, d: &Deployment, image: &str, pull_first: bool) -> anyhow::Result<()> {
    if pull_first && let Err(e) = pull(docker, log, image).await {
        // Locally built images can't be pulled; carry on if the image exists.
        if docker.inspect_image(image).await.is_ok() {
            log.line(format!("pull failed ({e}); using local image")).await;
        } else {
            return Err(e);
        }
    }
    destroy_all(docker, log, d).await?;

    let (exposed, bindings) = parse_ports(&d.ports).map_err(|e| anyhow::anyhow!(e.message))?;
    let env = lines(&d.env).map(str::to_string).collect::<Vec<_>>();
    let binds = lines(&d.volumes).map(str::to_string).collect::<Vec<_>>();
    let cmd = d.command.split_whitespace().map(str::to_string).collect::<Vec<_>>();
    let restart = parse_restart(&d.restart).map_err(|e| anyhow::anyhow!(e.message))?;

    let body = ContainerCreateBody {
        image: Some(image.to_string()),
        env: (!env.is_empty()).then_some(env),
        cmd: (!cmd.is_empty()).then_some(cmd),
        exposed_ports: (!exposed.is_empty()).then_some(exposed),
        labels: Some({
            let mut labels = parse_labels(&d.labels);
            labels.insert(LABEL.to_string(), d.name.clone());
            labels
        }),
        host_config: Some(HostConfig {
            port_bindings: (!bindings.is_empty()).then_some(bindings),
            binds: (!binds.is_empty()).then_some(binds),
            network_mode: (!d.network.is_empty()).then(|| d.network.clone()),
            restart_policy: Some(RestartPolicy {
                name: Some(restart),
                maximum_retry_count: None,
            }),
            ..Default::default()
        }),
        ..Default::default()
    };
    let created = docker
        .create_container(
            Some(CreateContainerOptions {
                name: Some(d.name.clone()),
                ..Default::default()
            }),
            body,
        )
        .await?;
    for w in created.warnings {
        log.line(format!("warning: {w}")).await;
    }
    log.line(format!("created container {} from {image}", &created.id[..12])).await;
    docker
        .start_container(&d.name, None::<StartContainerOptions>)
        .await?;
    log.line("container started").await;
    Ok(())
}

pub fn system_user(name: &str) -> User {
    User {
        id: 0,
        username: name.to_string(),
    }
}

async fn has_running_deploy(state: &AppState, name: &str) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM updates WHERE target_type = 'deployment' AND target_name = ? AND status = 'running'",
    )
    .bind(name)
    .fetch_one(&state.db)
    .await?
        > 0)
}

/// Triggers a deploy for a new commit, recording it as seen first so the
/// same commit is never deployed twice by the webhook and poller.
async fn deploy_commit(state: &AppState, d: Deployment, sha: &str, by: &str) -> AppResult<Update> {
    sqlx::query("UPDATE deployments SET last_seen_commit = ? WHERE id = ?")
        .bind(sha)
        .bind(d.id)
        .execute(&state.db)
        .await?;
    run_action(state, &system_user(by), d, "deploy").await
}

/// GitHub push webhook. Configure it with the deployment's webhook secret and
/// content type `application/json`.
async fn github_webhook(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<(StatusCode, Json<Value>)> {
    let unauthorized = || AppError::new(StatusCode::UNAUTHORIZED, "invalid webhook signature");
    // An unknown name looks the same as a bad signature, so deployment names
    // can't be probed without the secret.
    let d = fetch(&state, &name).await.map_err(|_| unauthorized())?;
    let push = git::parse_push(&headers, &body, &d.webhook_secret, &d.git_branch, d.auto_deploy && d.source == "git", &d.last_seen_commit)
        .map_err(|_| unauthorized())?;
    webhook_response(match push {
        git::Push::Deploy(sha) => git::Push::Deploy(deploy_commit(&state, d, &sha, "github").await?.id.to_string()),
        other => other,
    })
}

/// Turns a webhook outcome into its HTTP response (`Deploy` carries the update id).
pub fn webhook_response(push: git::Push) -> AppResult<(StatusCode, Json<Value>)> {
    Ok(match push {
        git::Push::Ping => (StatusCode::OK, Json(json!({ "ok": true }))),
        git::Push::Ignored(reason) => (StatusCode::ACCEPTED, Json(json!({ "ignored": reason }))),
        git::Push::Deploy(id) => (StatusCode::OK, Json(json!({ "update_id": id.parse::<i64>().unwrap_or_default() }))),
    })
}

/// Polls auto-deploy repositories for new commits, so pushes deploy even when
/// GitHub can't reach this server. `HARBOR_GIT_POLL_SECS=0` disables it.
pub fn spawn_poller(state: AppState) {
    let secs: u64 = std::env::var("HARBOR_GIT_POLL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    if secs == 0 {
        tracing::info!("git polling disabled");
        return;
    }
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(secs));
        loop {
            tick.tick().await;
            let due = sqlx::query_as::<_, Deployment>("SELECT * FROM deployments WHERE source = 'git' AND auto_deploy = 1")
                .fetch_all(&state.db)
                .await
                .unwrap_or_default();
            for d in due {
                if let Err(e) = poll_one(&state, d).await {
                    tracing::warn!("auto-deploy check failed: {e:#}");
                }
            }
            crate::stacks::poll(&state).await;
        }
    });
}

async fn poll_one(state: &AppState, d: Deployment) -> anyhow::Result<()> {
    // A long build would otherwise queue a deploy on every tick.
    if has_running_deploy(state, &d.name).await? {
        return Ok(());
    }
    let head = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        git::remote_head(&d.git_url, &d.git_branch, &d.token(&state.db).await),
    )
    .await
    .map_err(|_| anyhow::anyhow!("timed out checking {}", d.name))??;
    let Some(sha) = head else {
        anyhow::bail!("branch '{}' not found for {}", d.git_branch, d.name);
    };
    if sha != d.last_seen_commit {
        tracing::info!("new commit {} for {}; deploying", &sha[..7.min(sha.len())], d.name);
        deploy_commit(state, d, &sha, "auto-deploy").await.map_err(|e| anyhow::anyhow!(e.message))?;
    }
    Ok(())
}

/// Non-empty, non-comment lines.
fn lines(s: &str) -> impl Iterator<Item = &str> {
    s.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#'))
}

fn parse_restart(s: &str) -> AppResult<RestartPolicyNameEnum> {
    Ok(match s {
        "no" | "" => RestartPolicyNameEnum::NO,
        "always" => RestartPolicyNameEnum::ALWAYS,
        "unless-stopped" => RestartPolicyNameEnum::UNLESS_STOPPED,
        "on-failure" => RestartPolicyNameEnum::ON_FAILURE,
        other => return Err(AppError::bad_request(format!("invalid restart policy '{other}'"))),
    })
}

/// Parses port lines like `8080:80`, `127.0.0.1:8080:80/udp` or `80`.
fn parse_ports(s: &str) -> AppResult<(Vec<String>, PortMap)> {
    let mut exposed = Vec::new();
    let mut bindings = PortMap::new();
    for line in lines(s) {
        let (spec, proto) = line.split_once('/').unwrap_or((line, "tcp"));
        let parts: Vec<&str> = spec.split(':').collect();
        let (host_ip, host_port, container_port) = match parts.as_slice() {
            [c] => (None, None, *c),
            [h, c] => (None, Some(*h), *c),
            [ip, h, c] => (Some(*ip), Some(*h), *c),
            _ => return Err(AppError::bad_request(format!("invalid port mapping '{line}'"))),
        };
        if container_port.parse::<u16>().is_err() || host_port.is_some_and(|h| h.parse::<u16>().is_err()) {
            return Err(AppError::bad_request(format!("invalid port mapping '{line}'")));
        }
        let key = format!("{container_port}/{proto}");
        exposed.push(key.clone());
        if let Some(host_port) = host_port {
            bindings.entry(key).or_insert_with(|| Some(Vec::new())).as_mut().unwrap().push(PortBinding {
                host_ip: host_ip.map(str::to_string),
                host_port: Some(host_port.to_string()),
            });
        }
    }
    exposed.dedup();
    Ok((exposed, bindings))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_port_specs() {
        let (exposed, bindings) = parse_ports("8080:80\n# comment\n127.0.0.1:5353:53/udp\n9000").unwrap();
        assert_eq!(exposed, vec!["80/tcp", "53/udp", "9000/tcp"]);
        let b = bindings["80/tcp"].as_ref().unwrap();
        assert_eq!(b[0].host_port.as_deref(), Some("8080"));
        let b = bindings["53/udp"].as_ref().unwrap();
        assert_eq!(b[0].host_ip.as_deref(), Some("127.0.0.1"));
        assert!(!bindings.contains_key("9000/tcp"));
        assert!(parse_ports("abc:80").is_err());
    }

    #[test]
    fn defaults_image_tag() {
        assert_eq!(with_default_tag("nginx"), "nginx:latest");
        assert_eq!(with_default_tag("nginx:1.27"), "nginx:1.27");
        assert_eq!(with_default_tag("localhost:5000/app"), "localhost:5000/app:latest");
        assert_eq!(with_default_tag("ghcr.io/a/b@sha256:abc"), "ghcr.io/a/b@sha256:abc");
    }
}
