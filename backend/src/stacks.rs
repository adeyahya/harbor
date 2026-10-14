//! Stacks are Docker Compose projects. The compose file is either edited in
//! Harbor ("inline", written to `<data>/stacks/<name>/`) or comes from a git
//! repository checked out on the host. Imported stacks keep running from
//! their original project directory so relative paths resolve as before.

use std::path::{Path as FsPath, PathBuf};

use anyhow::Context;
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use bollard::models::{ContainerSummary, ContainerSummaryStateEnum};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use tokio::process::Command;

use crate::{
    auth::User,
    deployments::{system_user, webhook_response},
    docker::containers_with_label,
    error::{AppError, AppResult},
    git,
    state::{AppState, now, validate_name},
    updates::{self, Update, UpdateLog},
};

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Stack {
    pub id: i64,
    pub name: String,
    /// Compose file content for inline stacks.
    pub compose: String,
    pub env: String,
    pub created_at: String,
    pub updated_at: String,
    /// Directory compose resolves relative paths against. Empty means
    /// Harbor's stack folder (inline) or its checkout (git).
    pub project_dir: String,
    /// "inline" or "git".
    pub source: String,
    pub git_url: String,
    pub git_branch: String,
    #[serde(rename = "has_token", serialize_with = "is_set")]
    pub git_token: String,
    /// Compose file path inside the repository.
    pub compose_path: String,
    pub auto_deploy: bool,
    pub webhook_secret: String,
    pub last_commit: String,
    pub last_commit_message: String,
    pub last_seen_commit: String,
}

fn is_set<S: Serializer>(value: &str, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_bool(!value.is_empty())
}

#[derive(Serialize)]
pub struct StackListItem {
    #[serde(flatten)]
    stack: Stack,
    status: &'static str,
    containers_running: usize,
    containers_total: usize,
}

#[derive(Serialize)]
pub struct StackDetail {
    #[serde(flatten)]
    stack: Stack,
    status: &'static str,
    containers: Vec<ContainerSummary>,
}

#[derive(Deserialize, Default)]
pub struct StackInput {
    pub name: Option<String>,
    #[serde(default)]
    pub compose: String,
    #[serde(default)]
    pub env: String,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub project_dir: String,
    #[serde(default)]
    pub git_url: String,
    #[serde(default)]
    pub git_branch: String,
    /// Absent keeps the stored token, "" clears it, anything else replaces it.
    pub git_token: Option<String>,
    #[serde(default = "default_compose_path")]
    pub compose_path: String,
    #[serde(default)]
    pub auto_deploy: bool,
}

fn default_source() -> String {
    "inline".into()
}
fn default_compose_path() -> String {
    "compose.yaml".into()
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{name}", get(detail).put(update).delete(remove))
        .route("/{name}/rollback/{update_id}", post(rollback))
        .route("/{name}/{action}", post(action))
}

/// Unauthenticated webhook routes, verified by signature.
pub fn webhook_router() -> Router<AppState> {
    Router::new()
        .route("/github/stacks/{name}", post(github_webhook))
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
}

/// What a stack deploy ran with, stored on its update for rollback: the
/// files for inline stacks, the commit for git stacks.
#[derive(Serialize, Deserialize)]
struct Snapshot {
    #[serde(default)]
    compose: String,
    env: String,
    #[serde(default)]
    commit: String,
}

fn project_label(name: &str) -> String {
    format!("com.docker.compose.project={name}")
}

fn status_of(containers: &[ContainerSummary]) -> &'static str {
    let running = containers
        .iter()
        .filter(|c| c.state == Some(ContainerSummaryStateEnum::RUNNING))
        .count();
    match (running, containers.len()) {
        (_, 0) => "down",
        (r, t) if r == t => "running",
        (0, _) => "stopped",
        _ => "unhealthy",
    }
}

pub async fn fetch(state: &AppState, name: &str) -> AppResult<Stack> {
    sqlx::query_as::<_, Stack>("SELECT * FROM stacks WHERE name = ?")
        .bind(name)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found(format!("stack '{name}' not found")))
}

async fn list(State(state): State<AppState>) -> AppResult<Json<Vec<StackListItem>>> {
    let stacks = sqlx::query_as::<_, Stack>("SELECT * FROM stacks ORDER BY name")
        .fetch_all(&state.db)
        .await?;
    // One Docker call for all compose containers, grouped by project.
    let all = containers_with_label(&state.docker, "com.docker.compose.project")
        .await
        .unwrap_or_default();
    let items = stacks
        .into_iter()
        .map(|stack| {
            let mine: Vec<_> = all
                .iter()
                .filter(|c| {
                    c.labels
                        .as_ref()
                        .and_then(|l| l.get("com.docker.compose.project"))
                        .is_some_and(|p| *p == stack.name)
                })
                .cloned()
                .collect();
            StackListItem {
                status: status_of(&mine),
                containers_running: mine
                    .iter()
                    .filter(|c| c.state == Some(ContainerSummaryStateEnum::RUNNING))
                    .count(),
                containers_total: mine.len(),
                stack,
            }
        })
        .collect();
    Ok(Json(items))
}

async fn detail(State(state): State<AppState>, Path(name): Path<String>) -> AppResult<Json<StackDetail>> {
    let stack = fetch(&state, &name).await?;
    let mut containers = containers_with_label(&state.docker, &project_label(&name)).await?;
    containers.sort_by(|a, b| a.names.cmp(&b.names));
    Ok(Json(StackDetail {
        status: status_of(&containers),
        containers,
        stack,
    }))
}

/// Normalizes and validates input, resolving a blank branch to the default.
async fn prepare(input: &mut StackInput, stored_token: &str) -> AppResult<()> {
    input.project_dir = input.project_dir.trim().to_string();
    if !input.project_dir.is_empty() && !FsPath::new(&input.project_dir).is_absolute() {
        return Err(AppError::bad_request("project directory must be an absolute path"));
    }
    match input.source.as_str() {
        "inline" => {}
        "git" => {
            input.git_url = git::normalize_url(&input.git_url);
            if input.git_url.is_empty() || input.git_url.starts_with('-') {
                return Err(AppError::bad_request("repository URL is required"));
            }
            let token = input.git_token.as_deref().unwrap_or(stored_token);
            input.git_branch = git::resolve_branch(&input.git_url, &input.git_branch, token)
                .await
                .map_err(AppError::bad_request)?;
            if input.git_branch.starts_with('-') || input.git_branch.contains(char::is_whitespace) {
                return Err(AppError::bad_request("invalid branch name"));
            }
            input.compose_path = input.compose_path.trim().to_string();
            git::validate_rel_path(&input.compose_path, "compose file path").map_err(AppError::bad_request)?;
        }
        other => return Err(AppError::bad_request(format!("unknown source '{other}'"))),
    }
    Ok(())
}

pub async fn insert(state: &AppState, mut input: StackInput) -> AppResult<Stack> {
    let name = input.name.clone().unwrap_or_default();
    validate_name(&name)?;
    prepare(&mut input, "").await?;
    let ts = now();
    Ok(sqlx::query_as::<_, Stack>(
        "INSERT INTO stacks (name, compose, env, created_at, updated_at, project_dir, source, git_url, git_branch,
           git_token, compose_path, auto_deploy, webhook_secret)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(&name)
    .bind(&input.compose)
    .bind(&input.env)
    .bind(&ts)
    .bind(&ts)
    .bind(&input.project_dir)
    .bind(&input.source)
    .bind(&input.git_url)
    .bind(&input.git_branch)
    .bind(input.git_token.as_deref().unwrap_or("").trim())
    .bind(&input.compose_path)
    .bind(input.auto_deploy)
    .bind(hex::encode(rand::random::<[u8; 20]>()))
    .fetch_one(&state.db)
    .await?)
}

async fn create(State(state): State<AppState>, Json(input): Json<StackInput>) -> AppResult<Json<Stack>> {
    Ok(Json(insert(&state, input).await?))
}

async fn update(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(mut input): Json<StackInput>,
) -> AppResult<Json<Stack>> {
    let existing = fetch(&state, &name).await?;
    prepare(&mut input, &existing.git_token).await?;
    let stack = sqlx::query_as::<_, Stack>(
        "UPDATE stacks SET compose = ?, env = ?, updated_at = ?, project_dir = ?, source = ?, git_url = ?, git_branch = ?,
           git_token = COALESCE(?, git_token), compose_path = ?, auto_deploy = ?
         WHERE id = ? RETURNING *",
    )
    .bind(&input.compose)
    .bind(&input.env)
    .bind(now())
    .bind(&input.project_dir)
    .bind(&input.source)
    .bind(&input.git_url)
    .bind(&input.git_branch)
    .bind(input.git_token.as_deref().map(str::trim))
    .bind(&input.compose_path)
    .bind(input.auto_deploy)
    .bind(existing.id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(stack))
}

/// Deletes the stack record. Refuses while containers still exist so that
/// running services are never orphaned from the UI; run "down" first.
/// Only Harbor's own folder is removed, never an imported project directory.
async fn remove(State(state): State<AppState>, Path(name): Path<String>) -> AppResult<Json<Stack>> {
    let stack = fetch(&state, &name).await?;
    let containers = containers_with_label(&state.docker, &project_label(&name)).await?;
    if !containers.is_empty() {
        return Err(AppError::conflict(
            "stack still has containers; take it down before deleting",
        ));
    }
    sqlx::query("DELETE FROM stacks WHERE id = ?")
        .bind(stack.id)
        .execute(&state.db)
        .await?;
    let dir = state.stacks_dir().join(&name);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await.ok();
    }
    Ok(Json(stack))
}

async fn action(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path((name, action)): Path<(String, String)>,
) -> AppResult<Json<Update>> {
    if !matches!(action.as_str(), "deploy" | "pull" | "start" | "stop" | "restart" | "down") {
        return Err(AppError::bad_request(format!("unknown action '{action}'")));
    }
    let stack = fetch(&state, &name).await?;
    if stack.source == "inline" && stack.compose.trim().is_empty() {
        return Err(AppError::bad_request("stack has no compose file"));
    }
    Ok(Json(run_op(&state, &user, stack, &action, None).await?))
}

/// Where a stack's files live and how compose is invoked for it.
struct Layout {
    /// Harbor's folder for the stack: inline compose file and `.env`.
    own_dir: PathBuf,
    /// The git checkout (git stacks).
    checkout: PathBuf,
}

impl Layout {
    fn of(state: &AppState, stack: &Stack) -> Self {
        let own_dir = state.stacks_dir().join(&stack.name);
        let checkout = if stack.project_dir.is_empty() {
            own_dir.join("repo")
        } else {
            PathBuf::from(&stack.project_dir)
        };
        Self { own_dir, checkout }
    }

    fn compose_file(&self, stack: &Stack) -> PathBuf {
        if stack.source == "git" {
            self.checkout.join(&stack.compose_path)
        } else {
            self.own_dir.join("compose.yaml")
        }
    }

    /// Relative paths in the compose file resolve against this directory.
    fn project_dir(&self, stack: &Stack) -> PathBuf {
        if stack.source == "git" {
            let file = self.compose_file(stack);
            file.parent().map(FsPath::to_path_buf).unwrap_or_else(|| self.checkout.clone())
        } else if stack.project_dir.is_empty() {
            self.own_dir.clone()
        } else {
            PathBuf::from(&stack.project_dir)
        }
    }

    fn env_file(&self) -> PathBuf {
        self.own_dir.join(".env")
    }
}

/// Starts a stack operation as a tracked update. Operations on one stack are
/// serialized so overlapping deploys queue up.
async fn run_op(state: &AppState, user: &User, stack: Stack, action: &str, rollback_to: Option<Update>) -> AppResult<Update> {
    let op = action.to_string();
    let st = state.clone();
    updates::spawn(state, user, "stack", &stack.name.clone(), action, move |log| async move {
        let _guard = lock(&st, &stack.name, &log).await;
        // Re-read so a queued operation uses the latest saved settings.
        let stack = fetch(&st, &stack.name).await.map_err(|e| anyhow::anyhow!(e.message))?;
        let layout = Layout::of(&st, &stack);
        write_files(&layout, &stack).await?;
        match op.as_str() {
            "deploy" => deploy(&st, &log, &layout, &stack).await,
            "rollback" => roll_back(&st, &log, &layout, &stack, rollback_to.expect("rollback target")).await,
            other => {
                let args: &[&str] = match other {
                    "pull" => &["pull"],
                    "start" => &["start"],
                    "stop" => &["stop"],
                    "restart" => &["restart"],
                    "down" => &["down", "--remove-orphans"],
                    _ => unreachable!(),
                };
                if stack.source == "git" && !layout.compose_file(&stack).exists() {
                    anyhow::bail!("the repository hasn't been checked out yet; deploy first");
                }
                compose(&log, &layout, &stack, args).await
            }
        }
    })
    .await
}

const UP: &[&str] = &["up", "-d", "--remove-orphans"];

async fn deploy(state: &AppState, log: &UpdateLog, layout: &Layout, stack: &Stack) -> anyhow::Result<()> {
    let mut commit = String::new();
    if stack.source == "git" {
        let c = git::sync_checkout(log, &layout.checkout, &stack.git_url, &stack.git_branch, &stack.git_token).await?;
        log.line(format!("checked out {} \"{}\"", c.short(), c.message)).await;
        log.set_detail(&format!("{} {}", c.short(), c.message)).await;
        sqlx::query("UPDATE stacks SET last_seen_commit = ? WHERE id = ?")
            .bind(&c.sha)
            .bind(stack.id)
            .execute(&state.db)
            .await?;
        if !layout.compose_file(stack).is_file() {
            anyhow::bail!("no compose file at {} in the repository", stack.compose_path);
        }
        commit = c.sha.clone();
        compose(log, layout, stack, UP).await?;
        sqlx::query("UPDATE stacks SET last_commit = ?, last_commit_message = ? WHERE id = ?")
            .bind(&c.sha)
            .bind(&c.message)
            .bind(stack.id)
            .execute(&state.db)
            .await?;
    } else {
        compose(log, layout, stack, UP).await?;
    }
    let snapshot = Snapshot {
        compose: if stack.source == "git" { String::new() } else { stack.compose.clone() },
        env: stack.env.clone(),
        commit,
    };
    log.set_artifact("", &serde_json::to_string(&snapshot)?).await;
    Ok(())
}

/// Serializes operations on one stack so overlapping deploys queue up.
async fn lock(state: &AppState, name: &str, log: &UpdateLog) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = state.lock_for(&format!("stack:{name}"));
    match lock.clone().try_lock_owned() {
        Ok(g) => g,
        Err(_) => {
            log.line("waiting for the previous operation on this stack to finish…").await;
            lock.lock_owned().await
        }
    }
}

/// Restores a previous deploy (its files, or its commit for git stacks) and
/// runs `docker compose up` with it.
async fn rollback(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path((name, update_id)): Path<(String, i64)>,
) -> AppResult<Json<Update>> {
    let stack = fetch(&state, &name).await?;
    let target = sqlx::query_as::<_, Update>("SELECT * FROM updates WHERE id = ?")
        .bind(update_id)
        .fetch_optional(&state.db)
        .await?
        .filter(|u| u.target_type == "stack" && u.target_name == stack.name)
        .ok_or_else(|| AppError::not_found("deploy not found for this stack"))?;
    if target.status != "success" || !matches!(target.operation.as_str(), "deploy" | "rollback") || target.snapshot.is_empty() {
        return Err(AppError::bad_request("only successful deploys made by this version of Harbor can be rolled back to"));
    }
    let snapshot: Snapshot = serde_json::from_str(&target.snapshot).map_err(|e| anyhow::anyhow!(e))?;
    if stack.source == "git" && snapshot.commit.is_empty() {
        return Err(AppError::bad_request("that deploy was made before this stack used git; it can't be rolled back to"));
    }
    Ok(Json(run_op(&state, &user, stack, "rollback", Some(target)).await?))
}

async fn roll_back(state: &AppState, log: &UpdateLog, layout: &Layout, stack: &Stack, target: Update) -> anyhow::Result<()> {
    let snapshot: Snapshot = serde_json::from_str(&target.snapshot)?;
    let when = target.started_at.get(..16).unwrap_or(&target.started_at).replace('T', " ");
    let restored = if stack.source == "git" {
        // Restore the commit; `last_seen_commit` stays so the poller doesn't
        // immediately redeploy the newer head.
        log.line(format!("checking out {} from deploy #{}", &snapshot.commit[..7.min(snapshot.commit.len())], target.id)).await;
        let c = git::fetch_and_reset(log, &layout.checkout, &stack.git_url, &snapshot.commit, &stack.git_token).await?;
        log.set_detail(&format!("↩ {} {}", c.short(), c.message)).await;
        sqlx::query_as::<_, Stack>(
            "UPDATE stacks SET env = ?, last_commit = ?, last_commit_message = ?, updated_at = ? WHERE id = ? RETURNING *",
        )
        .bind(&snapshot.env)
        .bind(&c.sha)
        .bind(&c.message)
        .bind(now())
        .bind(stack.id)
        .fetch_one(&state.db)
        .await?
    } else {
        log.line(format!("restoring compose file and variables from deploy #{} ({when} UTC)", target.id)).await;
        log.set_detail(&format!("↩ deploy #{} from {when} UTC", target.id)).await;
        sqlx::query_as::<_, Stack>("UPDATE stacks SET compose = ?, env = ?, updated_at = ? WHERE id = ? RETURNING *")
            .bind(&snapshot.compose)
            .bind(&snapshot.env)
            .bind(now())
            .bind(stack.id)
            .fetch_one(&state.db)
            .await?
    };
    write_files(layout, &restored).await?;
    compose(log, layout, &restored, UP).await?;
    log.set_artifact("", &target.snapshot).await;
    Ok(())
}

async fn write_files(layout: &Layout, stack: &Stack) -> anyhow::Result<()> {
    let dir = &layout.own_dir;
    tokio::fs::create_dir_all(dir)
        .await
        .with_context(|| format!("creating {}", dir.display()))?;
    if stack.source == "inline" {
        tokio::fs::write(dir.join("compose.yaml"), &stack.compose).await?;
    }
    tokio::fs::write(layout.env_file(), &stack.env).await?;
    Ok(())
}

/// Runs `docker compose` for the stack with absolute paths, streaming its
/// output into the update log.
async fn compose(log: &UpdateLog, layout: &Layout, stack: &Stack, args: &[&str]) -> anyhow::Result<()> {
    let project_dir = layout.project_dir(stack);
    if !project_dir.is_dir() {
        anyhow::bail!(
            "project directory {} doesn't exist{}",
            project_dir.display(),
            if stack.project_dir.is_empty() { "" } else { " (if Harbor runs in Docker, mount it at the same path)" }
        );
    }
    let mut cmd = Command::new("docker");
    cmd.arg("compose")
        .arg("-p")
        .arg(&stack.name)
        .arg("--project-directory")
        .arg(&project_dir)
        .arg("-f")
        .arg(layout.compose_file(stack));
    // Git stacks with no Harbor variables keep using the repository's own .env.
    if stack.source == "inline" || !stack.env.trim().is_empty() {
        cmd.arg("--env-file").arg(layout.env_file());
    }
    cmd.args(args)
        .current_dir(&project_dir)
        .env("COMPOSE_ANSI", "never")
        .env("COMPOSE_PROGRESS", "plain");
    crate::process::run(log, cmd, &format!("docker compose -p {} {}", stack.name, args.join(" "))).await
}

async fn deploy_commit(state: &AppState, stack: Stack, sha: &str, by: &str) -> AppResult<Update> {
    sqlx::query("UPDATE stacks SET last_seen_commit = ? WHERE id = ?")
        .bind(sha)
        .bind(stack.id)
        .execute(&state.db)
        .await?;
    run_op(state, &system_user(by), stack, "deploy", None).await
}

async fn github_webhook(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<(StatusCode, Json<Value>)> {
    let unauthorized = || AppError::new(StatusCode::UNAUTHORIZED, "invalid webhook signature");
    let stack = fetch(&state, &name).await.map_err(|_| unauthorized())?;
    let push = git::parse_push(
        &headers,
        &body,
        &stack.webhook_secret,
        &stack.git_branch,
        stack.auto_deploy && stack.source == "git",
        &stack.last_seen_commit,
    )
    .map_err(|_| unauthorized())?;
    webhook_response(match push {
        git::Push::Deploy(sha) => git::Push::Deploy(deploy_commit(&state, stack, &sha, "github").await?.id.to_string()),
        other => other,
    })
}

/// Checks auto-deploy git stacks for new commits (called by the poller).
pub async fn poll(state: &AppState) {
    let due = sqlx::query_as::<_, Stack>("SELECT * FROM stacks WHERE source = 'git' AND auto_deploy = 1")
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    for stack in due {
        if let Err(e) = poll_one(state, stack).await {
            tracing::warn!("auto-deploy check failed: {e:#}");
        }
    }
}

async fn poll_one(state: &AppState, stack: Stack) -> anyhow::Result<()> {
    let running: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM updates WHERE target_type = 'stack' AND target_name = ? AND status = 'running'",
    )
    .bind(&stack.name)
    .fetch_one(&state.db)
    .await?;
    if running > 0 {
        return Ok(());
    }
    let head = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        git::remote_head(&stack.git_url, &stack.git_branch, &stack.git_token),
    )
    .await
    .map_err(|_| anyhow::anyhow!("timed out checking {}", stack.name))??;
    let Some(sha) = head else {
        anyhow::bail!("branch '{}' not found for {}", stack.git_branch, stack.name);
    };
    if sha != stack.last_seen_commit {
        tracing::info!("new commit {} for stack {}; deploying", &sha[..7.min(sha.len())], stack.name);
        deploy_commit(state, stack, &sha, "auto-deploy").await.map_err(|e| anyhow::anyhow!(e.message))?;
    }
    Ok(())
}
