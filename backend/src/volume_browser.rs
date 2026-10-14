//! Read-only file browser for Docker volumes.
//!
//! Volume data isn't necessarily on Harbor's filesystem (Docker Desktop keeps
//! it in a VM), so each browsed volume gets a small helper container with the
//! volume mounted read-only at `/vol`, and files are listed and read by
//! exec'ing busybox tools in it. Helpers are reused while in use, removed
//! after a period of inactivity, and hidden from Harbor's container lists.

use std::{
    collections::HashMap,
    path::{Component, Path as FsPath},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::Response,
};
use bollard::{
    Docker,
    container::LogOutput,
    exec::StartExecResults,
    models::{ContainerCreateBody, ContainerSummary, ExecConfig, HostConfig, Mount, MountType},
    query_parameters::{CreateContainerOptions, CreateImageOptions, ListContainersOptions, RemoveContainerOptions, StartContainerOptions},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

/// Label on helper containers; Harbor hides these everywhere.
pub const HELPER_LABEL: &str = "harbor.helper";
const HELPER_KIND: &str = "volume-browser";
const HELPER_IMAGE: &str = "alpine:3.20";
const ROOT: &str = "/vol";
const MAX_ENTRIES: usize = 2000;
const PREVIEW_BYTES: usize = 1024 * 1024;

/// Helper containers by volume name, with when they were last used.
#[derive(Clone, Default)]
pub struct Helpers(Arc<Mutex<HashMap<String, (String, Instant)>>>);

pub fn is_helper(c: &ContainerSummary) -> bool {
    c.labels.as_ref().is_some_and(|l| l.contains_key(HELPER_LABEL))
}

/// Removes helpers left over from a previous run and starts the idle reaper.
pub async fn init(state: &AppState) {
    for c in helper_containers(&state.docker).await {
        if let Some(id) = c.id {
            remove(&state.docker, &id).await;
        }
    }
    let idle = Duration::from_secs(
        std::env::var("HARBOR_HELPER_IDLE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(600),
    );
    let state = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(idle.as_secs().clamp(1, 60)));
        loop {
            tick.tick().await;
            let expired: Vec<(String, String)> = {
                let mut map = state.helpers.0.lock().expect("helpers poisoned");
                let expired: Vec<_> = map
                    .iter()
                    .filter(|(_, (_, used))| used.elapsed() >= idle)
                    .map(|(v, (id, _))| (v.clone(), id.clone()))
                    .collect();
                for (v, _) in &expired {
                    map.remove(v);
                }
                expired
            };
            for (volume, id) in expired {
                tracing::info!("removing idle volume browser for {volume}");
                remove(&state.docker, &id).await;
            }
        }
    });
}

async fn helper_containers(docker: &Docker) -> Vec<ContainerSummary> {
    docker
        .list_containers(Some(ListContainersOptions {
            all: true,
            filters: Some(HashMap::from([("label".to_string(), vec![format!("{HELPER_LABEL}={HELPER_KIND}")])])),
            ..Default::default()
        }))
        .await
        .unwrap_or_default()
}

async fn remove(docker: &Docker, id: &str) {
    let _ = docker
        .remove_container(id, Some(RemoveContainerOptions { force: true, ..Default::default() }))
        .await;
}

/// Removes the helper for `volume`, e.g. before the volume itself is removed.
pub async fn release(state: &AppState, volume: &str) {
    let entry = state.helpers.0.lock().expect("helpers poisoned").remove(volume);
    if let Some((id, _)) = entry {
        remove(&state.docker, &id).await;
    }
    // Also catch helpers this process doesn't know about.
    for c in helper_containers(&state.docker).await {
        if c.labels.as_ref().and_then(|l| l.get("harbor.volume")).is_some_and(|v| v == volume)
            && let Some(id) = c.id
        {
            remove(&state.docker, &id).await;
        }
    }
}

/// Removes every helper (before pruning volumes).
pub async fn release_all(state: &AppState) {
    state.helpers.0.lock().expect("helpers poisoned").clear();
    for c in helper_containers(&state.docker).await {
        if let Some(id) = c.id {
            remove(&state.docker, &id).await;
        }
    }
}

/// Returns a running helper for the volume, creating one if needed.
async fn helper(state: &AppState, volume: &str) -> AppResult<String> {
    let lock = state.lock_for(&format!("volume-browser:{volume}"));
    let _guard = lock.lock().await;
    let known = state.helpers.0.lock().expect("helpers poisoned").get(volume).map(|(id, _)| id.clone());
    if let Some(id) = known {
        let running = state
            .docker
            .inspect_container(&id, None)
            .await
            .ok()
            .and_then(|c| c.state)
            .and_then(|s| s.running)
            .unwrap_or(false);
        if running {
            touch(state, volume, &id);
            return Ok(id);
        }
        remove(&state.docker, &id).await;
    }

    state.docker.inspect_volume(volume).await?;
    if state.docker.inspect_image(HELPER_IMAGE).await.is_err() {
        let mut pull = state.docker.create_image(
            Some(CreateImageOptions { from_image: Some(HELPER_IMAGE.into()), ..Default::default() }),
            None,
            None,
        );
        while let Some(item) = pull.next().await {
            item.map_err(|e| AppError::new(StatusCode::BAD_GATEWAY, format!("pulling {HELPER_IMAGE}: {e}")))?;
        }
    }
    let created = state
        .docker
        .create_container(
            Some(CreateContainerOptions::default()),
            ContainerCreateBody {
                image: Some(HELPER_IMAGE.into()),
                cmd: Some(vec!["sleep".into(), "infinity".into()]),
                labels: Some(HashMap::from([
                    (HELPER_LABEL.to_string(), HELPER_KIND.to_string()),
                    ("harbor.volume".to_string(), volume.to_string()),
                ])),
                network_disabled: Some(true),
                host_config: Some(HostConfig {
                    mounts: Some(vec![Mount {
                        target: Some(ROOT.into()),
                        source: Some(volume.into()),
                        typ: Some(MountType::VOLUME),
                        read_only: Some(true),
                        ..Default::default()
                    }]),
                    network_mode: Some("none".into()),
                    auto_remove: Some(true),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await?;
    state.docker.start_container(&created.id, None::<StartContainerOptions>).await?;
    touch(state, volume, &created.id);
    Ok(created.id)
}

fn touch(state: &AppState, volume: &str, id: &str) {
    state
        .helpers
        .0
        .lock()
        .expect("helpers poisoned")
        .insert(volume.to_string(), (id.to_string(), Instant::now()));
}

/// Runs a command in the helper, returning (stdout, stderr, exit code).
/// stdout is capped at `limit` bytes.
async fn exec(docker: &Docker, id: &str, cmd: Vec<String>, limit: usize) -> AppResult<(Vec<u8>, String, i64)> {
    let exec = docker
        .create_exec(id, ExecConfig { cmd: Some(cmd), attach_stdout: Some(true), attach_stderr: Some(true), ..Default::default() })
        .await?;
    let mut stdout = Vec::new();
    let mut stderr = String::new();
    if let StartExecResults::Attached { mut output, .. } = docker.start_exec(&exec.id, None).await? {
        while let Some(chunk) = output.next().await {
            match chunk? {
                LogOutput::StdOut { message } if stdout.len() < limit => stdout.extend_from_slice(&message),
                LogOutput::StdErr { message } => stderr.push_str(&String::from_utf8_lossy(&message)),
                _ => {}
            }
        }
    }
    let code = docker.inspect_exec(&exec.id).await?.exit_code.unwrap_or(0);
    Ok((stdout, stderr, code))
}

#[derive(Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    path: String,
}

/// `/vol` joined with a relative path; rejects anything escaping the volume.
fn resolve(path: &str) -> AppResult<String> {
    let rel = path.trim().trim_start_matches('/');
    if rel.is_empty() {
        return Ok(ROOT.into());
    }
    if FsPath::new(rel).components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(AppError::bad_request("path must stay inside the volume"));
    }
    Ok(format!("{ROOT}/{rel}"))
}

fn not_found_or(stderr: &str, path: &str) -> AppError {
    if stderr.contains("No such file") || stderr.contains("can't open") {
        AppError::not_found(format!("{path} doesn't exist in this volume"))
    } else {
        AppError::bad_request(stderr.trim().to_string())
    }
}

#[derive(Serialize)]
pub struct VolumeDetail {
    name: String,
    driver: String,
    mountpoint: String,
    created_at: Option<String>,
    labels: HashMap<String, String>,
    /// Containers mounting this volume.
    used_by: Vec<UsedBy>,
}

#[derive(Serialize)]
pub struct UsedBy {
    id: String,
    name: String,
    state: String,
    destination: String,
}

pub async fn detail(State(state): State<AppState>, Path(name): Path<String>) -> AppResult<Json<VolumeDetail>> {
    let v = state.docker.inspect_volume(&name).await?;
    let containers = state
        .docker
        .list_containers(Some(ListContainersOptions {
            all: true,
            filters: Some(HashMap::from([("volume".to_string(), vec![name.clone()])])),
            ..Default::default()
        }))
        .await?;
    let used_by = containers
        .into_iter()
        .filter(|c| !is_helper(c))
        .map(|c| UsedBy {
            destination: c
                .mounts
                .iter()
                .flatten()
                .find(|m| m.name.as_deref() == Some(name.as_str()))
                .and_then(|m| m.destination.clone())
                .unwrap_or_default(),
            id: c.id.clone().unwrap_or_default(),
            name: c.names.as_ref().and_then(|n| n.first()).map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default(),
            state: c.state.map(|s| s.to_string()).unwrap_or_default(),
        })
        .collect();
    Ok(Json(VolumeDetail {
        name: v.name,
        driver: v.driver,
        mountpoint: v.mountpoint,
        created_at: v.created_at,
        labels: v.labels,
        used_by,
    }))
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    /// "dir", "file", "link" or "other".
    kind: &'static str,
    size: u64,
    /// Unix seconds.
    modified: i64,
    mode: String,
}

#[derive(Serialize)]
pub struct Listing {
    path: String,
    entries: Vec<Entry>,
    truncated: bool,
}

pub async fn list(State(state): State<AppState>, Path(name): Path<String>, Query(q): Query<PathQuery>) -> AppResult<Json<Listing>> {
    let dir = resolve(&q.path)?;
    let id = helper(&state, &name).await?;
    // Tab-separated stat output; `{} +` batches files into few stat calls.
    let cmd = ["find", &dir, "-mindepth", "1", "-maxdepth", "1", "-exec", "stat", "-c", "%F\t%s\t%Y\t%A\t%n", "{}", "+"];
    let (out, stderr, code) = exec(&state.docker, &id, cmd.iter().map(|s| s.to_string()).collect(), 32 * 1024 * 1024).await?;
    if code != 0 && out.is_empty() {
        return Err(not_found_or(&stderr, &q.path));
    }
    let prefix = format!("{}/", dir.trim_end_matches('/'));
    let text = String::from_utf8_lossy(&out);
    let mut entries: Vec<Entry> = text
        .lines()
        .filter_map(|line| {
            // The name is last, so a tab inside it stays part of the name.
            let mut parts = line.splitn(5, '\t');
            let (kind, size, modified, mode, full) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?, parts.next()?);
            Some(Entry {
                name: full.strip_prefix(&prefix).unwrap_or(full).to_string(),
                kind: match kind {
                    "directory" => "dir",
                    "regular file" | "regular empty file" => "file",
                    "symbolic link" => "link",
                    _ => "other",
                },
                size: size.parse().unwrap_or(0),
                modified: modified.parse().unwrap_or(0),
                mode: mode.to_string(),
            })
        })
        .collect();
    entries.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    Ok(Json(Listing { path: q.path.trim_matches('/').to_string(), entries, truncated }))
}

#[derive(Serialize)]
pub struct Preview {
    path: String,
    /// UTF-8 text, absent for binary files.
    content: Option<String>,
    binary: bool,
    /// Only the first megabyte is shown.
    truncated: bool,
}

pub async fn preview(State(state): State<AppState>, Path(name): Path<String>, Query(q): Query<PathQuery>) -> AppResult<Json<Preview>> {
    let file = resolve(&q.path)?;
    let id = helper(&state, &name).await?;
    let limit = (PREVIEW_BYTES + 1).to_string();
    let cmd = vec!["head".to_string(), "-c".into(), limit, file];
    let (mut out, stderr, code) = exec(&state.docker, &id, cmd, PREVIEW_BYTES + 1).await?;
    if code != 0 {
        return Err(not_found_or(&stderr, &q.path));
    }
    let truncated = out.len() > PREVIEW_BYTES;
    out.truncate(PREVIEW_BYTES);
    let binary = out.contains(&0) || std::str::from_utf8(&out).is_err() && !truncated;
    Ok(Json(Preview {
        path: q.path,
        content: (!binary).then(|| String::from_utf8_lossy(&out).into_owned()),
        binary,
        truncated,
    }))
}

/// Streams a file out of the volume without buffering it.
pub async fn download(State(state): State<AppState>, Path(name): Path<String>, Query(q): Query<PathQuery>) -> AppResult<Response> {
    let file = resolve(&q.path)?;
    let id = helper(&state, &name).await?;
    // Fail with a clear error before streaming if it isn't a regular file.
    let (_, stderr, code) = exec(&state.docker, &id, vec!["test".into(), "-f".into(), file.clone()], 0).await?;
    if code != 0 {
        return Err(if stderr.is_empty() { AppError::not_found(format!("{} isn't a file in this volume", q.path)) } else { not_found_or(&stderr, &q.path) });
    }
    let exec = state
        .docker
        .create_exec(&id, ExecConfig { cmd: Some(vec!["cat".into(), file]), attach_stdout: Some(true), ..Default::default() })
        .await?;
    let StartExecResults::Attached { output, .. } = state.docker.start_exec(&exec.id, None).await? else {
        return Err(AppError::new(StatusCode::BAD_GATEWAY, "couldn't read the file"));
    };
    let stream = output.filter_map(|chunk| async move {
        match chunk {
            Ok(LogOutput::StdOut { message }) => Some(Ok::<_, std::io::Error>(message)),
            Ok(_) => None,
            Err(e) => Some(Err(std::io::Error::other(e.to_string()))),
        }
    });
    let filename = q.path.rsplit('/').next().unwrap_or("download").replace('"', "");
    let mime = mime_guess::from_path(&filename).first_or_octet_stream();
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}\""))
        .body(Body::from_stream(stream))
        .expect("valid response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_paths_inside_the_volume() {
        assert_eq!(resolve("").unwrap(), "/vol");
        assert_eq!(resolve("/").unwrap(), "/vol");
        assert_eq!(resolve("a/b.txt").unwrap(), "/vol/a/b.txt");
        assert_eq!(resolve("/a/b").unwrap(), "/vol/a/b");
        assert!(resolve("../etc").is_err());
        assert!(resolve("a/../../etc").is_err());
    }
}
