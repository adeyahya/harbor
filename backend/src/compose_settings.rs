//! Prefilling a deployment from a repository's compose files.
//!
//! The chosen files are checked out (only them and env files) and merged by
//! `docker compose config`, which applies overrides, interpolates
//! `${VAR:-default}` and normalizes short and long syntax to JSON. Each
//! service is then mapped onto deployment settings; whatever a deployment
//! can't express is reported as a warning instead of being dropped silently.

use std::path::{Component, Path};

use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::process::Command;

use crate::{
    error::{AppError, AppResult},
    git,
    state::AppState,
};

#[derive(Deserialize)]
pub struct Query {
    git_url: String,
    #[serde(default)]
    git_branch: String,
    #[serde(default)]
    git_account_id: Option<i64>,
    /// Compose files in the order they are merged; the first is the main one.
    files: Vec<String>,
    /// Deployment name, used as the compose project so named volumes get the
    /// same names `docker compose` would give them.
    #[serde(default)]
    name: String,
}

#[derive(Serialize)]
pub struct Prefill {
    git_branch: String,
    services: Vec<ServiceSettings>,
    /// Messages from `docker compose config`, e.g. unset variables.
    warnings: Vec<String>,
}

/// Deployment settings for one compose service, in the deployment's formats.
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct ServiceSettings {
    service: String,
    /// Set when the service builds from the repository.
    build: bool,
    build_context: String,
    dockerfile: String,
    build_args: String,
    /// The image for services without `build:`.
    image: String,
    ports: String,
    env: String,
    volumes: String,
    network: String,
    restart: String,
    command: String,
    labels: String,
    devices: String,
    group_add: String,
    /// Settings that couldn't be carried over.
    warnings: Vec<String>,
}

pub async fn prefill(
    State(state): State<AppState>,
    Json(q): Json<Query>,
) -> AppResult<Json<Prefill>> {
    let url = git::normalize_url(&q.git_url);
    if url.is_empty() || url.starts_with('-') {
        return Err(AppError::bad_request("repository URL is required"));
    }
    if q.files.is_empty() {
        return Err(AppError::bad_request("choose a compose file"));
    }
    for f in &q.files {
        git::validate_rel_path(f, "compose file path").map_err(AppError::bad_request)?;
    }
    let project = if q.name.is_empty() {
        "app".to_string()
    } else {
        crate::state::validate_name(&q.name)?;
        q.name.clone()
    };
    let token = crate::accounts::resolve_token(&state.db, &url, q.git_account_id, "").await;
    let branch = git::resolve_branch(&url, &q.git_branch, &token)
        .await
        .map_err(AppError::bad_request)?;
    if branch.starts_with('-') || branch.contains(char::is_whitespace) {
        return Err(AppError::bad_request("invalid branch name"));
    }

    let scratch = state.data_dir.join("tmp").join(format!(
        "compose-settings-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(90),
        load_config(&url, &branch, &token, &scratch, &q.files, &project),
    )
    .await;
    tokio::fs::remove_dir_all(&scratch).await.ok();
    let (config, env_files, warnings) = result
        .map_err(|_| AppError::bad_request("timed out reading the repository"))?
        .map_err(|e| AppError::bad_request(format!("{e:#}")))?;

    let base = dir_of(&q.files[0]);
    let services = config["services"]
        .as_object()
        .map(|svcs| {
            svcs.iter()
                .map(|(name, svc)| map_service(name, svc, &config, &base, &env_files))
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(Prefill {
        git_branch: branch,
        services,
        warnings,
    }))
}

/// Env files found in the checkout, by path relative to the repository.
type EnvFiles = Vec<(String, String)>;

/// Checks out the compose files and env files, and returns the merged
/// config, the env files' contents and compose's warnings.
async fn load_config(
    url: &str,
    branch: &str,
    token: &str,
    scratch: &Path,
    files: &[String],
    project: &str,
) -> anyhow::Result<(Value, EnvFiles, Vec<String>)> {
    let all = git::sparse_checkout(url, branch, token, scratch, |path| {
        files.iter().any(|f| f == path) || is_env_file(path)
    })
    .await?;
    for f in files {
        if !all.contains(f) {
            anyhow::bail!("no compose file at {f} in the repository");
        }
    }
    let mut env_files = Vec::new();
    for path in all.iter().filter(|p| is_env_file(p)) {
        if let Ok(text) = tokio::fs::read_to_string(scratch.join(path)).await {
            env_files.push((path.clone(), text));
        }
    }

    // A clean environment, so Harbor's own variables never end up in the
    // prefilled settings; the repository's `.env` still applies.
    let mut cmd = Command::new("docker");
    cmd.env_clear();
    for key in ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG"] {
        if let Some(v) = std::env::var_os(key) {
            cmd.env(key, v);
        }
    }
    cmd.args(["compose", "-p", project]);
    for f in files {
        cmd.arg("-f").arg(scratch.join(f));
    }
    cmd.args([
        "config",
        "--format",
        "json",
        "--no-path-resolution",
        "--no-env-resolution",
    ])
    .current_dir(scratch)
    .kill_on_drop(true);
    let out = cmd
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("failed to run `docker compose`: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    let scratch_str = scratch.to_string_lossy();
    let clean = |s: &str| s.replace(&format!("{scratch_str}/"), "").trim().to_string();
    if !out.status.success() {
        anyhow::bail!("docker compose couldn't read the files: {}", clean(&stderr));
    }
    let config: Value = serde_json::from_slice(&out.stdout)?;
    let warnings = stderr
        .lines()
        .map(clean)
        .filter(|l| !l.is_empty())
        .collect();
    Ok((config, env_files, warnings))
}

/// `.env`, `app.env`, `.env.production` and the like.
fn is_env_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name == ".env" || name.starts_with(".env.") || name.ends_with(".env")
}

fn dir_of(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(d, _)| d.to_string())
        .unwrap_or_default()
}

/// Joins a path relative to `base` (a folder in the repository) and
/// normalizes it; `None` if it leaves the repository or is absolute.
fn repo_path(base: &str, rel: &str) -> Option<String> {
    if Path::new(rel).is_absolute() {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    for c in Path::new(base).join(rel).components() {
        match c {
            Component::Normal(p) => out.push(p.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop()?;
            }
            _ => return None,
        }
    }
    Some(if out.is_empty() {
        ".".into()
    } else {
        out.join("/")
    })
}

/// Keys the mapping handles, or that don't matter for a single container.
const HANDLED: &[&str] = &[
    "build",
    "image",
    "ports",
    "environment",
    "env_file",
    "volumes",
    "networks",
    "network_mode",
    "restart",
    "command",
    "entrypoint",
    "labels",
    "devices",
    "group_add",
    "container_name",
    "depends_on",
    "expose",
];

fn str_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn map_service(
    name: &str,
    svc: &Value,
    config: &Value,
    base: &str,
    env_files: &EnvFiles,
) -> ServiceSettings {
    let mut s = ServiceSettings {
        service: name.to_string(),
        restart: "unless-stopped".into(),
        build_context: ".".into(),
        dockerfile: "Dockerfile".into(),
        ..Default::default()
    };
    let warn = |s: &mut ServiceSettings, msg: String| s.warnings.push(msg);

    // Build or image.
    if let Some(build) = svc.get("build").filter(|b| b.is_object()) {
        s.build = true;
        let context = build["context"].as_str().unwrap_or(".");
        match repo_path(base, context) {
            Some(c) if !context.contains("://") => s.build_context = c,
            _ => warn(
                &mut s,
                format!("build context {context} is outside the repository; using its root"),
            ),
        }
        if let Some(df) = build["dockerfile"].as_str() {
            match repo_path("", df) {
                Some(df) => s.dockerfile = df,
                None => warn(
                    &mut s,
                    format!("Dockerfile path {df} must be inside the build context"),
                ),
            }
        }
        if build.get("dockerfile_inline").is_some() {
            warn(
                &mut s,
                "inline Dockerfiles aren't supported; add a Dockerfile to the repository".into(),
            );
        }
        if let Some(args) = build["args"].as_object() {
            s.build_args = kv_lines(args);
        }
        for key in [
            "target",
            "secrets",
            "ssh",
            "additional_contexts",
            "platforms",
        ] {
            if build.get(key).is_some() {
                warn(&mut s, format!("build {key} isn't supported"));
            }
        }
    } else {
        s.image = svc["image"].as_str().unwrap_or_default().to_string();
    }

    // Ports.
    let mut ports = Vec::new();
    for p in svc["ports"].as_array().into_iter().flatten() {
        let target = str_of(&p["target"]);
        let published = str_of(&p["published"]);
        let proto = p["protocol"].as_str().unwrap_or("tcp");
        if published.contains('-') || target.contains('-') {
            warn(
                &mut s,
                format!(
                    "port range {published}:{target} isn't supported; add the ports one by one"
                ),
            );
            continue;
        }
        let mut spec = match (p["host_ip"].as_str(), published.as_str()) {
            (_, "") => target,
            (Some(ip), h) if !ip.is_empty() => format!("{ip}:{h}:{target}"),
            (_, h) => format!("{h}:{target}"),
        };
        if proto != "tcp" {
            spec = format!("{spec}/{proto}");
        }
        ports.push(spec);
    }
    s.ports = ports.join("\n");

    // Environment: env files first, so `environment:` wins as in compose.
    let mut env: Vec<(String, String)> = Vec::new();
    let mut set = |k: String, v: String| match env.iter_mut().find(|(key, _)| *key == k) {
        Some(e) => e.1 = v,
        None => env.push((k, v)),
    };
    for f in svc["env_file"].as_array().into_iter().flatten() {
        let rel = f["path"].as_str().unwrap_or_default();
        let found =
            repo_path(base, rel).and_then(|p| env_files.iter().find(|(path, _)| *path == p));
        match found {
            Some((_, text)) => {
                for line in text.lines().map(str::trim) {
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    let line = line.strip_prefix("export ").unwrap_or(line);
                    if let Some((k, v)) = line.split_once('=') {
                        let v = v.trim();
                        let unquoted = v
                            .strip_prefix('"')
                            .and_then(|v| v.strip_suffix('"'))
                            .or_else(|| v.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                            .unwrap_or(v);
                        set(k.trim().to_string(), unquoted.to_string());
                    }
                }
            }
            None if f["required"] == Value::Bool(false) => {}
            None => warn(
                &mut s,
                format!(
                    "env file {rel} isn't in the repository; add its variables under Variables"
                ),
            ),
        }
    }
    let mut unset = Vec::new();
    for (k, v) in svc["environment"].as_object().into_iter().flatten() {
        if v.is_null() {
            unset.push(k.clone());
        } else {
            set(k.clone(), str_of(v));
        }
    }
    if !unset.is_empty() {
        warn(
            &mut s,
            format!(
                "{} {} from the host in compose; set {} under Variables",
                unset.join(", "),
                if unset.len() == 1 {
                    "gets its value"
                } else {
                    "get their values"
                },
                if unset.len() == 1 { "it" } else { "them" }
            ),
        );
    }
    s.env = env
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n");

    // Volumes.
    let mut volumes = Vec::new();
    for v in svc["volumes"].as_array().into_iter().flatten() {
        let source = v["source"].as_str().unwrap_or_default();
        let target = v["target"].as_str().unwrap_or_default();
        let ro = if v["read_only"] == Value::Bool(true) {
            ":ro"
        } else {
            ""
        };
        match v["type"].as_str().unwrap_or_default() {
            "volume" if !source.is_empty() => {
                // The real name, e.g. `<project>_data`, or an external volume's.
                let real = config["volumes"][source]["name"].as_str().unwrap_or(source);
                volumes.push(format!("{real}:{target}{ro}"));
            }
            "bind" if source.starts_with('/') => volumes.push(format!("{source}:{target}{ro}")),
            "bind" => warn(
                &mut s,
                format!(
                    "{source}:{target} is relative to the repository; set an absolute host path or a named volume under Volumes"
                ),
            ),
            "volume" => warn(
                &mut s,
                format!("anonymous volume {target} isn't supported; use a named volume"),
            ),
            other => warn(&mut s, format!("{other} mount at {target} isn't supported")),
        }
    }
    s.volumes = volumes.join("\n");

    // Network.
    match svc["network_mode"].as_str() {
        Some(mode @ ("host" | "bridge" | "none")) => s.network = mode.into(),
        Some(mode) => warn(&mut s, format!("network_mode {mode} isn't supported")),
        None => {
            let nets: Vec<&String> = svc["networks"]
                .as_object()
                .map(|n| n.keys().filter(|k| *k != "default").collect())
                .unwrap_or_default();
            if let [net] = nets.as_slice() {
                match config["networks"][net.as_str()]["name"].as_str() {
                    Some(real)
                        if config["networks"][net.as_str()]["external"] == Value::Bool(true) =>
                    {
                        s.network = real.into()
                    }
                    _ => warn(
                        &mut s,
                        format!(
                            "network {net} is created by compose; create it first and set it under Network"
                        ),
                    ),
                }
            } else if !nets.is_empty() {
                warn(
                    &mut s,
                    "only one network can be set; choose one under Network".into(),
                );
            }
        }
    }

    // Restart policy.
    let restart = svc["restart"].as_str().unwrap_or("no");
    s.restart = match restart.split(':').next().unwrap_or("no") {
        p @ ("no" | "always" | "unless-stopped" | "on-failure") => p.into(),
        other => {
            warn(&mut s, format!("restart policy {other} isn't supported"));
            "unless-stopped".into()
        }
    };

    // Command.
    match &svc["command"] {
        Value::Array(parts) => {
            let parts: Vec<String> = parts.iter().map(str_of).collect();
            if parts.iter().any(|p| p.contains(char::is_whitespace)) {
                warn(&mut s, "the command has arguments with spaces, which deployments split on spaces; check it under Command".into());
            }
            s.command = parts.join(" ");
        }
        Value::String(c) => s.command = c.clone(),
        _ => {}
    }
    if !svc["entrypoint"].is_null() {
        warn(
            &mut s,
            "entrypoint isn't supported; the image's entrypoint is used".into(),
        );
    }

    if let Some(labels) = svc["labels"].as_object() {
        s.labels = kv_lines(labels);
    }

    // Devices and groups, e.g. for hardware acceleration.
    let mut devices = Vec::new();
    for d in svc["devices"].as_array().into_iter().flatten() {
        let (src, dst, perms) = match d {
            Value::String(spec) => {
                devices.push(spec.clone());
                continue;
            }
            _ => (
                str_of(&d["source"]),
                str_of(&d["target"]),
                str_of(&d["permissions"]),
            ),
        };
        let mut spec = src.clone();
        if !dst.is_empty() && dst != src {
            spec = format!("{spec}:{dst}");
        }
        if !perms.is_empty() && perms != "rwm" {
            if dst.is_empty() || dst == src {
                spec = format!("{spec}:{src}");
            }
            spec = format!("{spec}:{perms}");
        }
        devices.push(spec);
    }
    s.devices = devices.join("\n");
    s.group_add = svc["group_add"]
        .as_array()
        .into_iter()
        .flatten()
        .map(str_of)
        .collect::<Vec<_>>()
        .join("\n");

    if let Some(deps) = svc["depends_on"].as_object().filter(|d| !d.is_empty()) {
        let names: Vec<&str> = deps.keys().map(String::as_str).collect();
        warn(
            &mut s,
            format!(
                "depends on {}, which must be deployed separately",
                names.join(", ")
            ),
        );
    }
    let mut other: Vec<&str> = svc
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, v)| !HANDLED.contains(&k.as_str()) && !v.is_null())
        .map(|(k, _)| k.as_str())
        .collect();
    other.sort_unstable();
    if !other.is_empty() {
        warn(&mut s, format!("not carried over: {}", other.join(", ")));
    }
    s
}

fn kv_lines(map: &Map<String, Value>) -> String {
    map.iter()
        .map(|(k, v)| format!("{k}={}", str_of(v)))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// What `docker compose config --format json` prints for a service with
    /// a build, a rockchip override and the usual settings.
    fn config() -> Value {
        json!({
            "services": {
                "web": {
                    "build": { "context": "./app", "dockerfile": "Dockerfile.prod", "args": { "VERSION": "1.2" } },
                    "restart": "unless-stopped",
                    "command": ["serve", "--host", "0.0.0.0"],
                    "devices": [
                        { "source": "/dev/dri", "target": "/dev/dri", "permissions": "rwm" },
                        { "source": "/dev/video0", "target": "/dev/video0", "permissions": "r" },
                        { "source": "/dev/rga", "target": "/dev/rga2", "permissions": "rwm" }
                    ],
                    "entrypoint": null,
                    "environment": { "EMPTY": null, "TZ": "UTC", "MODE": "prod" },
                    "env_file": [ { "path": ".env" }, { "path": "missing.env", "required": false } ],
                    "group_add": ["video"],
                    "security_opt": ["systempaths=unconfined"],
                    "labels": { "traefik.enable": "true" },
                    "networks": { "default": null },
                    "volumes": [
                        { "type": "bind", "source": "./data", "target": "/data", "bind": {} },
                        { "type": "bind", "source": "/srv/media", "target": "/media", "read_only": true },
                        { "type": "volume", "source": "cache", "target": "/cache", "volume": {} }
                    ],
                    "depends_on": { "db": { "condition": "service_started", "required": true } },
                    "ports": [
                        { "mode": "ingress", "target": 80, "published": "8080", "protocol": "tcp" },
                        { "mode": "ingress", "host_ip": "127.0.0.1", "target": 53, "published": "5353", "protocol": "udp" },
                        { "mode": "ingress", "target": 9000, "protocol": "tcp" }
                    ]
                },
                "db": { "image": "postgres:16", "restart": "on-failure:3" }
            },
            "volumes": { "cache": { "name": "photos_cache" } }
        })
    }

    #[test]
    fn maps_a_built_service_with_devices() {
        let cfg = config();
        let env = vec![(
            "deploy/.env".to_string(),
            "# c\nMODE=dev\nexport KEY=\"v 1\"\n".to_string(),
        )];
        let s = map_service("web", &cfg["services"]["web"], &cfg, "deploy", &env);
        assert!(s.build);
        assert_eq!(s.build_context, "deploy/app");
        assert_eq!(s.dockerfile, "Dockerfile.prod");
        assert_eq!(s.build_args, "VERSION=1.2");
        assert_eq!(s.ports, "8080:80\n127.0.0.1:5353:53/udp\n9000");
        // `environment:` overrides the env file, as in compose.
        assert_eq!(s.env, "MODE=prod\nKEY=v 1\nTZ=UTC");
        assert_eq!(s.volumes, "/srv/media:/media:ro\nphotos_cache:/cache");
        assert_eq!(s.restart, "unless-stopped");
        assert_eq!(s.command, "serve --host 0.0.0.0");
        assert_eq!(s.labels, "traefik.enable=true");
        assert_eq!(
            s.devices,
            "/dev/dri\n/dev/video0:/dev/video0:r\n/dev/rga:/dev/rga2"
        );
        assert_eq!(s.group_add, "video");
        let warnings = s.warnings.join("\n");
        for expected in [
            "EMPTY",
            "./data:/data",
            "depends on db",
            "not carried over: security_opt",
        ] {
            assert!(
                warnings.contains(expected),
                "missing {expected:?} in {warnings}"
            );
        }
        assert!(!warnings.contains("missing.env"));
        assert_eq!(s.warnings.len(), 4, "{warnings}");
    }

    #[test]
    fn maps_an_image_service() {
        let cfg = config();
        let s = map_service("db", &cfg["services"]["db"], &cfg, "", &vec![]);
        assert!(!s.build);
        assert_eq!(s.image, "postgres:16");
        assert_eq!(s.restart, "on-failure");
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn keeps_paths_inside_the_repository() {
        assert_eq!(repo_path("", ".").as_deref(), Some("."));
        assert_eq!(repo_path("deploy", "../app").as_deref(), Some("app"));
        assert_eq!(repo_path("deploy", "..").as_deref(), Some("."));
        assert_eq!(repo_path("", "../x"), None);
        assert_eq!(repo_path("", "/etc"), None);
        assert!(is_env_file(".env") && is_env_file("cfg/app.env") && is_env_file(".env.prod"));
        assert!(!is_env_file("environment.yml"));
    }

    #[test]
    fn device_specs_round_trip_through_the_deployment_parser() {
        // The strings produced above are what `parse_devices` accepts.
        let cfg = config();
        let s = map_service("web", &cfg["services"]["web"], &cfg, "", &vec![]);
        let parsed = crate::deployments::parse_devices(&s.devices).unwrap();
        let got: Vec<_> = parsed
            .iter()
            .map(|d| {
                (
                    d.path_on_host.as_deref().unwrap(),
                    d.path_in_container.as_deref().unwrap(),
                    d.cgroup_permissions.as_deref().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("/dev/dri", "/dev/dri", "rwm"),
                ("/dev/video0", "/dev/video0", "r"),
                ("/dev/rga", "/dev/rga2", "rwm"),
            ]
        );
    }
}
