//! Deployments are single containers defined by an image and a small set of
//! options. Deploying pulls the image and (re)creates a container named after
//! the deployment.

use std::collections::HashMap;

use axum::{
    Extension, Json, Router,
    extract::{Path, State},
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
use serde::{Deserialize, Serialize};

use crate::{
    auth::User,
    error::{AppError, AppResult},
    state::{AppState, now, validate_name},
    updates::{self, Update, UpdateLog},
};

const LABEL: &str = "harbor.deployment";

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Deployment {
    pub id: i64,
    pub name: String,
    pub image: String,
    pub ports: String,
    pub env: String,
    pub volumes: String,
    pub network: String,
    pub restart: String,
    pub command: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct DeploymentInput {
    name: Option<String>,
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
}

fn default_restart() -> String {
    "unless-stopped".into()
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
        .route("/{name}/{action}", post(action))
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
    let containers = crate::docker::containers_with_label(&state.docker, LABEL)
        .await
        .unwrap_or_default();
    let items = deployments
        .into_iter()
        .map(|deployment| {
            let c = containers.iter().find(|c| {
                c.labels
                    .as_ref()
                    .and_then(|l| l.get(LABEL))
                    .is_some_and(|n| *n == deployment.name)
            });
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
    let container = find_container(&state.docker, &name).await?;
    Ok(Json(DeploymentDetail {
        status: container_status(&container),
        container,
        deployment,
    }))
}

fn validate(input: &DeploymentInput) -> AppResult<()> {
    if input.image.trim().is_empty() {
        return Err(AppError::bad_request("image is required"));
    }
    parse_restart(&input.restart)?;
    parse_ports(&input.ports)?;
    Ok(())
}

async fn create(State(state): State<AppState>, Json(input): Json<DeploymentInput>) -> AppResult<Json<Deployment>> {
    let name = input.name.clone().unwrap_or_default();
    validate_name(&name)?;
    validate(&input)?;
    let ts = now();
    let d = sqlx::query_as::<_, Deployment>(
        "INSERT INTO deployments (name, image, ports, env, volumes, network, restart, command, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
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
    .fetch_one(&state.db)
    .await?;
    Ok(Json(d))
}

async fn update(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<DeploymentInput>,
) -> AppResult<Json<Deployment>> {
    validate(&input)?;
    let d = sqlx::query_as::<_, Deployment>(
        "UPDATE deployments SET image = ?, ports = ?, env = ?, volumes = ?, network = ?, restart = ?, command = ?, updated_at = ?
         WHERE name = ? RETURNING *",
    )
    .bind(input.image.trim())
    .bind(&input.ports)
    .bind(&input.env)
    .bind(&input.volumes)
    .bind(input.network.trim())
    .bind(&input.restart)
    .bind(&input.command)
    .bind(now())
    .bind(&name)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("deployment '{name}' not found")))?;
    Ok(Json(d))
}

async fn remove(State(state): State<AppState>, Path(name): Path<String>) -> AppResult<Json<Deployment>> {
    let d = fetch(&state, &name).await?;
    if find_container(&state.docker, &name).await?.is_some() {
        return Err(AppError::conflict(
            "deployment still has a container; destroy it before deleting",
        ));
    }
    sqlx::query("DELETE FROM deployments WHERE id = ?")
        .bind(d.id)
        .execute(&state.db)
        .await?;
    Ok(Json(d))
}

async fn action(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path((name, action)): Path<(String, String)>,
) -> AppResult<Json<Update>> {
    let d = fetch(&state, &name).await?;
    let docker = state.docker.clone();
    let op = action.clone();
    if !matches!(op.as_str(), "deploy" | "pull" | "start" | "stop" | "restart" | "destroy") {
        return Err(AppError::bad_request(format!("unknown action '{action}'")));
    }
    let update = updates::spawn(&state, &user, "deployment", &name, &action, move |log| async move {
        match op.as_str() {
            "deploy" => deploy(&docker, &log, &d).await,
            "pull" => pull(&docker, &log, &d.image).await,
            "start" => Ok(docker.start_container(&d.name, None::<StartContainerOptions>).await?),
            "stop" => Ok(docker.stop_container(&d.name, None::<StopContainerOptions>).await?),
            "restart" => Ok(docker.restart_container(&d.name, None::<RestartContainerOptions>).await?),
            "destroy" => destroy(&docker, &log, &d.name).await,
            _ => unreachable!(),
        }?;
        log.line(format!("{op} complete")).await;
        Ok(())
    })
    .await?;
    Ok(Json(update))
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

async fn deploy(docker: &Docker, log: &UpdateLog, d: &Deployment) -> anyhow::Result<()> {
    if let Err(e) = pull(docker, log, &d.image).await {
        // Locally built images can't be pulled; carry on if the image exists.
        if docker.inspect_image(&d.image).await.is_ok() {
            log.line(format!("pull failed ({e}); using local image")).await;
        } else {
            return Err(e);
        }
    }
    destroy(docker, log, &d.name).await?;

    let (exposed, bindings) = parse_ports(&d.ports).map_err(|e| anyhow::anyhow!(e.message))?;
    let env = lines(&d.env).map(str::to_string).collect::<Vec<_>>();
    let binds = lines(&d.volumes).map(str::to_string).collect::<Vec<_>>();
    let cmd = d.command.split_whitespace().map(str::to_string).collect::<Vec<_>>();
    let restart = parse_restart(&d.restart).map_err(|e| anyhow::anyhow!(e.message))?;

    let body = ContainerCreateBody {
        image: Some(d.image.clone()),
        env: (!env.is_empty()).then_some(env),
        cmd: (!cmd.is_empty()).then_some(cmd),
        exposed_ports: (!exposed.is_empty()).then_some(exposed),
        labels: Some(HashMap::from([(LABEL.to_string(), d.name.clone())])),
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
    log.line(format!("created container {}", &created.id[..12])).await;
    docker
        .start_container(&d.name, None::<StartContainerOptions>)
        .await?;
    log.line("container started").await;
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
