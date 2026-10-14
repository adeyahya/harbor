//! Stacks are Docker Compose projects whose files are edited in the UI and
//! stored in the database. Deploying writes them to `<data>/stacks/<name>/`
//! and shells out to `docker compose`.

use std::path::PathBuf;

use anyhow::Context;
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use bollard::models::{ContainerSummary, ContainerSummaryStateEnum};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::{
    auth::User,
    docker::containers_with_label,
    error::{AppError, AppResult},
    state::{AppState, now, validate_name},
    updates::{self, Update, UpdateLog},
};

#[derive(Serialize, sqlx::FromRow)]
pub struct Stack {
    pub id: i64,
    pub name: String,
    pub compose: String,
    pub env: String,
    pub created_at: String,
    pub updated_at: String,
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

#[derive(Deserialize)]
struct CreateStack {
    name: String,
    #[serde(default)]
    compose: String,
    #[serde(default)]
    env: String,
}

#[derive(Deserialize)]
struct UpdateStack {
    compose: String,
    #[serde(default)]
    env: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{name}", get(detail).put(update).delete(remove))
        .route("/{name}/{action}", post(action))
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

async fn fetch(state: &AppState, name: &str) -> AppResult<Stack> {
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

async fn create(State(state): State<AppState>, Json(body): Json<CreateStack>) -> AppResult<Json<Stack>> {
    validate_name(&body.name)?;
    let ts = now();
    let stack = sqlx::query_as::<_, Stack>(
        "INSERT INTO stacks (name, compose, env, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(&body.name)
    .bind(&body.compose)
    .bind(&body.env)
    .bind(&ts)
    .bind(&ts)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(stack))
}

async fn update(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<UpdateStack>,
) -> AppResult<Json<Stack>> {
    let stack = sqlx::query_as::<_, Stack>(
        "UPDATE stacks SET compose = ?, env = ?, updated_at = ? WHERE name = ? RETURNING *",
    )
    .bind(&body.compose)
    .bind(&body.env)
    .bind(now())
    .bind(&name)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("stack '{name}' not found")))?;
    Ok(Json(stack))
}

/// Deletes the stack record. Refuses while containers still exist so that
/// running services are never orphaned from the UI; run "down" first.
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
    let args: &[&str] = match action.as_str() {
        "deploy" => &["up", "-d", "--remove-orphans"],
        "pull" => &["pull"],
        "start" => &["start"],
        "stop" => &["stop"],
        "restart" => &["restart"],
        "down" => &["down", "--remove-orphans"],
        _ => return Err(AppError::bad_request(format!("unknown action '{action}'"))),
    };
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let stack = fetch(&state, &name).await?;
    if stack.compose.trim().is_empty() {
        return Err(AppError::bad_request("stack has no compose file"));
    }
    let dir = state.stacks_dir().join(&name);
    let update = updates::spawn(&state, &user, "stack", &name, &action, move |log| async move {
        write_files(&dir, &stack).await?;
        compose(&log, &dir, &stack.name, &args).await
    })
    .await?;
    Ok(Json(update))
}

async fn write_files(dir: &PathBuf, stack: &Stack) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .with_context(|| format!("creating {}", dir.display()))?;
    tokio::fs::write(dir.join("compose.yaml"), &stack.compose).await?;
    tokio::fs::write(dir.join(".env"), &stack.env).await?;
    Ok(())
}

/// Runs `docker compose` in the stack directory, streaming its output into
/// the update log line by line.
async fn compose(log: &UpdateLog, dir: &PathBuf, project: &str, args: &[String]) -> anyhow::Result<()> {
    let mut cmd = Command::new("docker");
    cmd.arg("compose")
        .args(["-p", project, "-f", "compose.yaml", "--env-file", ".env"])
        .args(args)
        .current_dir(dir)
        .env("COMPOSE_ANSI", "never")
        .env("COMPOSE_PROGRESS", "plain");
    crate::process::run(log, cmd, &format!("docker compose -p {project} {}", args.join(" "))).await
}
