//! Direct access to the local Docker engine: containers, images, volumes and
//! networks. Responses pass through Docker's own JSON shapes.

use std::{collections::HashMap, convert::Infallible};

use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    response::sse::{Event, KeepAlive, Sse},
    routing::{delete, get, post},
};
use bollard::{
    container::LogOutput,
    models::{ContainerInspectResponse, ContainerSummary, ImageSummary, Network, Volume},
    query_parameters::*,
};
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    auth::User,
    error::AppResult,
    state::AppState,
    updates::{self, Update},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/containers", get(list_containers))
        .route("/containers/{id}", get(inspect_container).delete(remove_container))
        .route("/containers/{id}/logs", get(container_logs))
        .route("/containers/{id}/terminal", get(crate::terminal::open))
        .route("/containers/{id}/{action}", post(container_action))
        .route("/images", get(list_images))
        .route("/image-ports", get(image_ports))
        .route("/images/{id}", delete(remove_image))
        .route("/volumes", get(list_volumes))
        .route("/volumes/{name}", get(crate::volume_browser::detail).delete(remove_volume))
        .route("/volumes/{name}/files", get(crate::volume_browser::list))
        .route("/volumes/{name}/file", get(crate::volume_browser::preview))
        .route("/volumes/{name}/download", get(crate::volume_browser::download))
        .route("/networks", get(list_networks))
        .route("/networks/{id}", delete(remove_network))
        .route("/prune/{kind}", post(prune))
}

pub fn label_filter(label: &str) -> Option<HashMap<String, Vec<String>>> {
    Some(HashMap::from([("label".to_string(), vec![label.to_string()])]))
}

pub async fn containers_with_label(
    docker: &bollard::Docker,
    label: &str,
) -> Result<Vec<ContainerSummary>, bollard::errors::Error> {
    docker
        .list_containers(Some(ListContainersOptions {
            all: true,
            filters: label_filter(label),
            ..Default::default()
        }))
        .await
}

async fn list_containers(State(state): State<AppState>) -> AppResult<Json<Vec<ContainerSummary>>> {
    let mut containers = state
        .docker
        .list_containers(Some(ListContainersOptions {
            all: true,
            ..Default::default()
        }))
        .await?;
    // Harbor's own helper containers aren't the user's.
    containers.retain(|c| !crate::volume_browser::is_helper(c));
    containers.sort_by(|a, b| a.names.cmp(&b.names));
    Ok(Json(containers))
}

async fn inspect_container(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<ContainerInspectResponse>> {
    Ok(Json(state.docker.inspect_container(&id, None).await?))
}

async fn container_display_name(state: &AppState, id: &str) -> String {
    state
        .docker
        .inspect_container(id, None)
        .await
        .ok()
        .and_then(|c| c.name)
        .map(|n| n.trim_start_matches('/').to_string())
        .unwrap_or_else(|| id.chars().take(12).collect())
}

async fn container_action(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path((id, action)): Path<(String, String)>,
) -> AppResult<Json<Update>> {
    if !matches!(action.as_str(), "start" | "stop" | "restart" | "pause" | "unpause" | "kill") {
        return Err(crate::error::AppError::bad_request(format!("unknown action '{action}'")));
    }
    let name = container_display_name(&state, &id).await;
    let docker = state.docker.clone();
    let op = action.clone();
    let update = updates::spawn(&state, &user, "container", &name, &action, move |log| async move {
        log.line(format!("{op} container {id}")).await;
        match op.as_str() {
            "start" => docker.start_container(&id, None::<StartContainerOptions>).await?,
            "stop" => docker.stop_container(&id, None::<StopContainerOptions>).await?,
            "restart" => docker.restart_container(&id, None::<RestartContainerOptions>).await?,
            "pause" => docker.pause_container(&id).await?,
            "unpause" => docker.unpause_container(&id).await?,
            "kill" => docker.kill_container(&id, None::<KillContainerOptions>).await?,
            _ => unreachable!(),
        }
        log.line("done").await;
        Ok(())
    })
    .await?;
    Ok(Json(update))
}

async fn remove_container(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> AppResult<Json<Update>> {
    let name = container_display_name(&state, &id).await;
    let docker = state.docker.clone();
    let update = updates::spawn(&state, &user, "container", &name, "remove", move |log| async move {
        docker
            .remove_container(
                &id,
                Some(RemoveContainerOptions {
                    force: true,
                    ..Default::default()
                }),
            )
            .await?;
        log.line(format!("removed container {id}")).await;
        Ok(())
    })
    .await?;
    Ok(Json(update))
}

#[derive(Deserialize)]
struct LogsQuery {
    tail: Option<String>,
    follow: Option<bool>,
    timestamps: Option<bool>,
}

/// Streams container logs as server-sent events, one event per chunk.
async fn container_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<LogsQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = state.docker.logs(
        &id,
        Some(LogsOptions {
            follow: q.follow.unwrap_or(true),
            stdout: true,
            stderr: true,
            timestamps: q.timestamps.unwrap_or(false),
            tail: q.tail.unwrap_or_else(|| "500".into()),
            ..Default::default()
        }),
    );
    let events = stream.map(|item| {
        let event = match item {
            Ok(output) => {
                let stream = match &output {
                    LogOutput::StdErr { .. } => "stderr",
                    _ => "stdout",
                };
                let text = String::from_utf8_lossy(&output.into_bytes()).into_owned();
                Event::default().event(stream).data(text)
            }
            Err(e) => Event::default().event("error").data(e.to_string()),
        };
        Ok(event)
    });
    Sse::new(events).keep_alive(KeepAlive::default())
}

async fn list_images(State(state): State<AppState>) -> AppResult<Json<Vec<Value>>> {
    let images: Vec<ImageSummary> = state
        .docker
        .list_images(Some(ListImagesOptions::default()))
        .await?;
    // Mark which images are referenced by a container so the UI can show "unused".
    let containers = state
        .docker
        .list_containers(Some(ListContainersOptions {
            all: true,
            ..Default::default()
        }))
        .await?;
    let used: std::collections::HashSet<_> =
        containers.iter().filter_map(|c| c.image_id.clone()).collect();
    let out = images
        .into_iter()
        .map(|img| {
            let in_use = used.contains(&img.id);
            let mut v = serde_json::to_value(img).unwrap_or_default();
            v["InUse"] = json!(in_use);
            v
        })
        .collect();
    Ok(Json(out))
}

#[derive(Deserialize)]
struct ImagePortsQuery {
    image: String,
}

/// Ports an image declares with EXPOSE. Only looks at local images; this is
/// a hint for the UI and never pulls.
async fn image_ports(State(state): State<AppState>, Query(q): Query<ImagePortsQuery>) -> AppResult<Json<Value>> {
    match state.docker.inspect_image(&q.image).await {
        Ok(img) => {
            let mut exposed = img.config.and_then(|c| c.exposed_ports).unwrap_or_default();
            exposed.sort();
            Ok(Json(json!({ "local": true, "exposed": exposed })))
        }
        Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => {
            Ok(Json(json!({ "local": false, "exposed": [] })))
        }
        Err(e) => Err(e.into()),
    }
}

async fn remove_image(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let res = state
        .docker
        .remove_image(&id, Some(RemoveImageOptions::default()), None)
        .await?;
    Ok(Json(serde_json::to_value(res).unwrap_or_default()))
}

async fn list_volumes(State(state): State<AppState>) -> AppResult<Json<Vec<Volume>>> {
    let res = state
        .docker
        .list_volumes(Some(ListVolumesOptions::default()))
        .await?;
    let mut volumes = res.volumes.unwrap_or_default();
    volumes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(volumes))
}

async fn remove_volume(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> AppResult<Json<Value>> {
    // A browser helper mounting the volume would make removal fail.
    crate::volume_browser::release(&state, &name).await;
    state
        .docker
        .remove_volume(&name, Some(RemoveVolumeOptions::default()))
        .await?;
    Ok(Json(json!({ "removed": name })))
}

async fn list_networks(State(state): State<AppState>) -> AppResult<Json<Vec<Network>>> {
    let mut networks = state
        .docker
        .list_networks(Some(ListNetworksOptions::default()))
        .await?;
    networks.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(networks))
}

async fn remove_network(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    state.docker.remove_network(&id).await?;
    Ok(Json(json!({ "removed": id })))
}

async fn prune(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path(kind): Path<String>,
) -> AppResult<Json<Update>> {
    if !matches!(kind.as_str(), "containers" | "images" | "volumes" | "networks") {
        return Err(crate::error::AppError::bad_request(format!("cannot prune '{kind}'")));
    }
    if kind == "volumes" {
        crate::volume_browser::release_all(&state).await;
    }
    let docker = state.docker.clone();
    let k = kind.clone();
    let update = updates::spawn(&state, &user, "system", &kind, "prune", move |log| async move {
        let report = match k.as_str() {
            "containers" => serde_json::to_string_pretty(
                &docker.prune_containers(None::<PruneContainersOptions>).await?,
            )?,
            // Only dangling images by default; mirror `docker image prune -a`
            // so unused tagged images are removed too.
            "images" => serde_json::to_string_pretty(
                &docker
                    .prune_images(Some(PruneImagesOptions {
                        filters: Some(HashMap::from([
                            ("dangling".to_string(), vec!["false".to_string()]),
                            // Keep Harbor's builds: they're rollback targets.
                            ("label!".to_string(), vec!["harbor.deployment".to_string()]),
                        ])),
                    }))
                    .await?,
            )?,
            "volumes" => serde_json::to_string_pretty(
                &docker
                    .prune_volumes(Some(PruneVolumesOptions {
                        // Without this, named volumes are kept on Docker >= 23.
                        filters: Some(HashMap::from([(
                            "all".to_string(),
                            vec!["true".to_string()],
                        )])),
                    }))
                    .await?,
            )?,
            "networks" => serde_json::to_string_pretty(
                &docker.prune_networks(None::<PruneNetworksOptions>).await?,
            )?,
            _ => unreachable!(),
        };
        log.line(report).await;
        Ok(())
    })
    .await?;
    Ok(Json(update))
}
