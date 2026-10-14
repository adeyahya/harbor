//! Importing containers Harbor didn't create (e.g. ones Komodo managed):
//! compose projects become stacks, standalone containers become deployments.
//! Nothing is restarted on import; the first deploy from Harbor recreates
//! the containers with Harbor's settings.

use std::{
    collections::{BTreeMap, HashSet},
    path::{Path as FsPath, PathBuf},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use bollard::{
    models::{ContainerSummary, MountType},
    query_parameters::ListContainersOptions,
};
use serde::{Deserialize, Serialize};

use crate::{
    deployments::Deployment,
    error::{AppError, AppResult},
    git,
    stacks::{self, Stack, StackInput},
    state::{AppState, now, validate_name},
};

const PROJECT: &str = "com.docker.compose.project";
const SERVICE: &str = "com.docker.compose.service";
const WORKING_DIR: &str = "com.docker.compose.project.working_dir";
const CONFIG_FILES: &str = "com.docker.compose.project.config_files";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(candidates))
        .route("/container/{name}", get(preview_container))
        .route("/container", post(import_container))
        .route("/stack", post(import_stack))
}

#[derive(Serialize)]
struct CandidateContainer {
    name: String,
    service: Option<String>,
    image: String,
    state: String,
    status: String,
}

#[derive(Serialize)]
struct StackCandidate {
    project: String,
    working_dir: String,
    config_files: Vec<String>,
    containers: Vec<CandidateContainer>,
    /// Harbor can read the compose file (it may not, if containerized
    /// without the directory mounted).
    compose_readable: bool,
    /// Existing git checkout in the working directory (Komodo git stacks).
    git_url: Option<String>,
    git_branch: Option<String>,
    git_had_credentials: bool,
    /// The project name is usable as a Harbor stack name.
    name_ok: bool,
    /// Part of Komodo itself (core, periphery, its database).
    is_komodo: bool,
    is_harbor: bool,
}

#[derive(Serialize)]
struct ContainerCandidate {
    #[serde(flatten)]
    container: CandidateContainer,
    suggested_name: String,
    ports: Vec<String>,
    is_komodo: bool,
    is_harbor: bool,
}

#[derive(Serialize)]
struct Candidates {
    stacks: Vec<StackCandidate>,
    containers: Vec<ContainerCandidate>,
}

fn label<'a>(c: &'a ContainerSummary, key: &str) -> Option<&'a str> {
    c.labels.as_ref()?.get(key).map(String::as_str)
}

fn name_of(c: &ContainerSummary) -> String {
    c.names
        .as_ref()
        .and_then(|n| n.first())
        .map(|n| n.trim_start_matches('/').to_string())
        .unwrap_or_default()
}

fn is_komodo_image(image: &str) -> bool {
    let i = image.to_lowercase();
    i.contains("komodo-core") || i.contains("komodo-periphery") || i.contains("moghtech/komodo") || i.contains("mbecker20/komodo")
}

/// Harbor's own container ID when it runs in Docker (from the cgroup mount
/// paths, which don't depend on the configured hostname).
fn own_container_id() -> Option<String> {
    let info = std::fs::read_to_string("/proc/self/mountinfo").ok()?;
    info.split("/containers/")
        .skip(1)
        .find_map(|rest| {
            let id: String = rest.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
            (id.len() == 64).then_some(id)
        })
}

/// A Harbor-valid name derived from a container name.
fn suggest_name(name: &str) -> String {
    let mut s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    s = s.trim_start_matches(['-', '_']).chars().take(63).collect();
    if s.is_empty() { "imported".into() } else { s }
}

fn summary(c: &ContainerSummary) -> CandidateContainer {
    CandidateContainer {
        name: name_of(c),
        service: label(c, SERVICE).map(str::to_string),
        image: c.image.clone().unwrap_or_default(),
        state: c.state.map(|s| s.to_string()).unwrap_or_default(),
        status: c.status.clone().unwrap_or_default(),
    }
}

async fn candidates(State(state): State<AppState>) -> AppResult<Json<Candidates>> {
    let containers = state
        .docker
        .list_containers(Some(ListContainersOptions { all: true, ..Default::default() }))
        .await?;
    let stack_names: HashSet<String> = sqlx::query_scalar("SELECT name FROM stacks").fetch_all(&state.db).await?.into_iter().collect();
    let deployment_names: HashSet<String> = sqlx::query_as::<_, (String, String)>("SELECT name, adopted_container FROM deployments")
        .fetch_all(&state.db)
        .await?
        .into_iter()
        .flat_map(|(n, a)| [n, a])
        .filter(|n| !n.is_empty())
        .collect();
    let own_id = own_container_id();

    let mut projects: BTreeMap<String, Vec<&ContainerSummary>> = BTreeMap::new();
    let mut standalone = Vec::new();
    for c in &containers {
        let managed = label(c, "harbor.deployment").is_some() || deployment_names.contains(&name_of(c));
        match label(c, PROJECT) {
            Some(p) if !stack_names.contains(p) && !managed => projects.entry(p.to_string()).or_default().push(c),
            Some(_) => {}
            None if !managed => standalone.push(c),
            None => {}
        }
    }

    let is_self = |c: &ContainerSummary| own_id.as_deref().is_some_and(|id| c.id.as_deref() == Some(id));
    let mut stacks = Vec::new();
    for (project, members) in projects {
        let first = members[0];
        let working_dir = label(first, WORKING_DIR).unwrap_or_default().to_string();
        let config_files: Vec<String> = label(first, CONFIG_FILES)
            .unwrap_or_default()
            .split(',')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let repo = if working_dir.is_empty() { None } else { git::repo_info(FsPath::new(&working_dir)).await };
        stacks.push(StackCandidate {
            compose_readable: config_files.first().is_some_and(|f| std::fs::read_to_string(f).is_ok()),
            name_ok: validate_name(&project).is_ok(),
            is_komodo: members.iter().any(|c| is_komodo_image(c.image.as_deref().unwrap_or_default())),
            is_harbor: members.iter().any(|c| is_self(c)),
            git_had_credentials: repo.as_ref().is_some_and(|r| r.had_credentials),
            git_url: repo.as_ref().map(|r| r.url.clone()),
            git_branch: repo.map(|r| r.branch),
            containers: members.iter().map(|c| summary(c)).collect(),
            project,
            working_dir,
            config_files,
        });
    }

    let containers = standalone
        .into_iter()
        .map(|c| {
            let mut ports: Vec<String> = c
                .ports
                .iter()
                .flatten()
                .filter_map(|p| p.public_port.map(|pub_| format!("{pub_}:{}", p.private_port)))
                .collect();
            ports.sort();
            ports.dedup();
            ContainerCandidate {
                suggested_name: suggest_name(&name_of(c)),
                is_komodo: is_komodo_image(c.image.as_deref().unwrap_or_default()),
                is_harbor: is_self(c),
                ports,
                container: summary(c),
            }
        })
        .collect();
    Ok(Json(Candidates { stacks, containers }))
}

/// Deployment settings derived from a running container, plus everything
/// Harbor can't carry over.
#[derive(Serialize)]
struct ContainerPreview {
    container: String,
    suggested_name: String,
    image: String,
    ports: String,
    env: String,
    volumes: String,
    network: String,
    restart: String,
    command: String,
    labels: String,
    warnings: Vec<String>,
}

async fn map_container(state: &AppState, name: &str) -> AppResult<ContainerPreview> {
    let c = state.docker.inspect_container(name, None).await?;
    let config = c.config.clone().unwrap_or_default();
    let host = c.host_config.clone().unwrap_or_default();
    let mut warnings = Vec::new();

    // Image defaults aren't part of the deployment's own settings.
    let image_config = match c.image.as_deref() {
        Some(id) => state.docker.inspect_image(id).await.ok().and_then(|i| i.config),
        None => None,
    };
    if image_config.is_none() {
        warnings.push("The container's image is no longer available locally, so all of its environment variables were imported, including the image's defaults.".into());
    }
    let image_env: HashSet<String> = image_config.as_ref().and_then(|i| i.env.clone()).unwrap_or_default().into_iter().collect();
    let env: Vec<String> = config.env.clone().unwrap_or_default().into_iter().filter(|e| !image_env.contains(e)).collect();

    let image = config.image.clone().unwrap_or_default();
    if image.starts_with("sha256:") {
        warnings.push("The container was started from an image ID rather than a name; set the image in Settings before deploying.".into());
    }

    let cmd = config.cmd.clone().unwrap_or_default();
    let image_cmd = image_config.as_ref().and_then(|i| i.cmd.clone()).unwrap_or_default();
    let command = if cmd != image_cmd && !cmd.is_empty() {
        if cmd.iter().any(|a| a.contains(char::is_whitespace)) {
            warnings.push(format!("The command has arguments containing spaces, which Harbor can't express yet: {}", cmd.join(" ")));
        }
        cmd.join(" ")
    } else {
        String::new()
    };
    let image_entrypoint = image_config.as_ref().and_then(|i| i.entrypoint.clone()).unwrap_or_default();
    if config.entrypoint.clone().unwrap_or_default() != image_entrypoint {
        warnings.push("Custom entrypoint isn't supported and will reset to the image's default.".into());
    }

    let mut ports: Vec<String> = host
        .port_bindings
        .clone()
        .unwrap_or_default()
        .into_iter()
        .flat_map(|(key, bindings)| {
            let (port, proto) = key.split_once('/').map(|(p, pr)| (p.to_string(), pr.to_string())).unwrap_or((key.clone(), "tcp".into()));
            bindings.unwrap_or_default().into_iter().map(move |b| {
                let ip = b.host_ip.unwrap_or_default();
                let ip = if ip.is_empty() || ip == "0.0.0.0" || ip == "::" { String::new() } else { format!("{ip}:") };
                let suffix = if proto == "tcp" { String::new() } else { format!("/{proto}") };
                format!("{ip}{}:{port}{suffix}", b.host_port.unwrap_or_default())
            })
        })
        .collect();
    ports.sort();
    ports.dedup();

    let mut volumes: Vec<String> = host.binds.clone().unwrap_or_default();
    for m in host.mounts.clone().unwrap_or_default() {
        let (Some(source), Some(target)) = (m.source, m.target) else { continue };
        match m.typ {
            Some(MountType::BIND) | Some(MountType::VOLUME) => {
                volumes.push(format!("{source}:{target}{}", if m.read_only == Some(true) { ":ro" } else { "" }));
            }
            Some(MountType::TMPFS) => warnings.push(format!("tmpfs mount at {target} isn't supported.")),
            _ => {}
        }
    }

    let network = match host.network_mode.as_deref() {
        None | Some("default") | Some("bridge") => String::new(),
        Some(m) if m.starts_with("container:") => {
            warnings.push(format!("Network mode '{m}' isn't supported; it will use the default network."));
            String::new()
        }
        Some(m) => m.to_string(),
    };
    let restart = host
        .restart_policy
        .as_ref()
        .and_then(|r| r.name)
        .map(|n| n.to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "no".into());

    // Labels Docker or Compose manage themselves aren't settings.
    let mut labels: Vec<String> = config
        .labels
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, _)| !k.starts_with("com.docker.") && !k.starts_with("org.opencontainers.") && k != "harbor.deployment")
        .filter(|(k, v)| image_config.as_ref().and_then(|i| i.labels.as_ref()).and_then(|l| l.get(k)) != Some(v))
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    labels.sort();

    // Only a driver other than the daemon's default is a container setting.
    let default_log_driver = state.docker.info().await.ok().and_then(|i| i.logging_driver).unwrap_or_else(|| "json-file".into());
    let unsupported: [(&str, bool); 14] = [
        ("privileged mode", host.privileged == Some(true)),
        ("added capabilities", host.cap_add.as_ref().is_some_and(|v| !v.is_empty())),
        ("dropped capabilities", host.cap_drop.as_ref().is_some_and(|v| !v.is_empty())),
        ("devices", host.devices.as_ref().is_some_and(|v| !v.is_empty())),
        ("extra hosts", host.extra_hosts.as_ref().is_some_and(|v| !v.is_empty())),
        ("custom DNS servers", host.dns.as_ref().is_some_and(|v| !v.is_empty())),
        ("memory limit", host.memory.unwrap_or(0) > 0),
        ("CPU limit", host.nano_cpus.unwrap_or(0) > 0 || host.cpu_shares.unwrap_or(0) > 0),
        ("sysctls", host.sysctls.as_ref().is_some_and(|v| !v.is_empty())),
        ("tmpfs mounts", host.tmpfs.as_ref().is_some_and(|v| !v.is_empty())),
        ("security options", host.security_opt.as_ref().is_some_and(|v| !v.is_empty())),
        ("a custom log driver", host.log_config.as_ref().and_then(|l| l.typ.as_deref()).is_some_and(|t| !t.is_empty() && t != default_log_driver)),
        ("a non-default user", config.user.as_deref().unwrap_or_default() != image_config.as_ref().and_then(|i| i.user.as_deref()).unwrap_or_default()),
        ("a custom healthcheck", config.healthcheck.is_some() && config.healthcheck != image_config.as_ref().and_then(|i| i.healthcheck.clone())),
    ];
    for (what, present) in unsupported {
        if present {
            warnings.push(format!("Uses {what}, which Harbor doesn't manage yet; it will be dropped when Harbor redeploys this container."));
        }
    }

    let container = c.name.clone().unwrap_or_default().trim_start_matches('/').to_string();
    Ok(ContainerPreview {
        suggested_name: suggest_name(&container),
        container,
        image,
        ports: lines(ports),
        env: lines(env),
        volumes: lines(volumes),
        network,
        restart,
        command,
        labels: lines(labels),
        warnings,
    })
}

fn lines(v: Vec<String>) -> String {
    if v.is_empty() { String::new() } else { v.join("\n") + "\n" }
}

async fn preview_container(State(state): State<AppState>, Path(name): Path<String>) -> AppResult<Json<ContainerPreview>> {
    Ok(Json(map_container(&state, &name).await?))
}

#[derive(Deserialize)]
struct ImportContainer {
    container: String,
    name: String,
}

async fn import_container(State(state): State<AppState>, Json(body): Json<ImportContainer>) -> AppResult<Json<Deployment>> {
    validate_name(&body.name)?;
    let p = map_container(&state, &body.container).await?;
    if p.image.is_empty() {
        return Err(AppError::bad_request("the container has no image name"));
    }
    let ts = now();
    let d = sqlx::query_as::<_, Deployment>(
        "INSERT INTO deployments (name, image, ports, env, volumes, network, restart, command, labels, adopted_container,
           created_at, updated_at, source, webhook_secret)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image', ?) RETURNING *",
    )
    .bind(&body.name)
    .bind(&p.image)
    .bind(&p.ports)
    .bind(&p.env)
    .bind(&p.volumes)
    .bind(&p.network)
    .bind(&p.restart)
    .bind(&p.command)
    .bind(&p.labels)
    .bind(&p.container)
    .bind(&ts)
    .bind(&ts)
    .bind(hex::encode(rand::random::<[u8; 20]>()))
    .fetch_one(&state.db)
    .await?;
    Ok(Json(d))
}

#[derive(Deserialize)]
struct ImportStack {
    project: String,
    /// Compose content, required when Harbor can't read the file itself.
    compose: Option<String>,
    env: Option<String>,
    /// Use the existing git checkout as the stack's source.
    git: Option<ImportGit>,
}

#[derive(Deserialize)]
struct ImportGit {
    git_url: String,
    #[serde(default)]
    git_branch: String,
    git_token: Option<String>,
}

async fn import_stack(State(state): State<AppState>, Json(body): Json<ImportStack>) -> AppResult<Json<Stack>> {
    if let Some(id) = own_container_id()
        && crate::docker::containers_with_label(&state.docker, &format!("{PROJECT}={}", body.project))
            .await?
            .iter()
            .any(|c| c.id.as_deref() == Some(id.as_str()))
    {
        return Err(AppError::bad_request("that's Harbor's own compose project; Harbor can't redeploy itself"));
    }
    validate_name(&body.project).map_err(|_| {
        AppError::bad_request("the compose project name isn't a valid Harbor stack name (lowercase letters, digits, '-' and '_')")
    })?;
    let containers = crate::docker::containers_with_label(&state.docker, &format!("{PROJECT}={}", body.project)).await?;
    let first = containers.first().ok_or_else(|| AppError::not_found("no containers for that compose project"))?;
    let working_dir = label(first, WORKING_DIR).unwrap_or_default().to_string();
    let config_file = label(first, CONFIG_FILES).unwrap_or_default().split(',').next().unwrap_or_default().to_string();

    // Git stacks take the compose file from the repository, so only inline
    // imports need to read (or be given) its content.
    let compose = match body.compose.filter(|c| !c.trim().is_empty()) {
        Some(c) => c,
        None if body.git.is_some() => String::new(),
        None => std::fs::read_to_string(&config_file).map_err(|_| {
            AppError::new(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                format!("compose_unreadable: Harbor can't read {config_file}; paste the compose file instead"),
            )
        })?,
    };
    // Komodo writes a stack's Environment to .env in its run directory.
    let env = body
        .env
        .or_else(|| std::fs::read_to_string(PathBuf::from(&working_dir).join(".env")).ok())
        .unwrap_or_default();

    let mut input = StackInput {
        name: Some(body.project.clone()),
        compose,
        env,
        project_dir: working_dir.clone(),
        ..Default::default()
    };
    if let Some(g) = body.git {
        // Keep using the checkout in place. The compose file may sit in a
        // subfolder of it, so paths are taken relative to the repository root.
        let root = git::repo_info(FsPath::new(&working_dir))
            .await
            .map(|r| r.root)
            .ok_or_else(|| AppError::bad_request(format!("{working_dir} isn't inside a git checkout that Harbor can read")))?;
        let compose_path = FsPath::new(&config_file)
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|_| AppError::bad_request("the compose file isn't inside the git checkout"))?;
        input.project_dir = root.to_string_lossy().into_owned();
        input.source = "git".into();
        input.git_url = g.git_url;
        input.git_branch = g.git_branch;
        input.git_token = g.git_token.filter(|t| !t.is_empty());
        input.compose_path = compose_path;
    } else {
        input.source = "inline".into();
        input.compose_path = "compose.yaml".into();
    }
    Ok(Json(stacks::insert(&state, input).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_valid_names() {
        assert_eq!(suggest_name("Legacy-App"), "legacy-app");
        assert_eq!(suggest_name("my.service_1"), "my-service_1");
        assert_eq!(suggest_name("__x"), "x");
        assert!(validate_name(&suggest_name("Some Weird Name!")).is_ok());
    }

    #[test]
    fn detects_komodo() {
        assert!(is_komodo_image("ghcr.io/moghtech/komodo-periphery:latest"));
        assert!(is_komodo_image("ghcr.io/mbecker20/komodo:1"));
        assert!(!is_komodo_image("nginx:alpine"));
    }
}
