//! Every mutating operation (deploy, pull, start, ...) is recorded as an
//! "update": a row holding its status and a running log, so the UI can follow
//! long-running work and keep a history of what happened.

use std::future::Future;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::get,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{
    auth::User,
    error::AppResult,
    state::{AppState, now},
};

#[derive(Serialize, sqlx::FromRow)]
pub struct Update {
    pub id: i64,
    pub operation: String,
    pub target_type: String,
    pub target_name: String,
    pub status: String,
    pub log: String,
    pub username: String,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// Handle given to a running operation for appending to its log.
#[derive(Clone)]
pub struct UpdateLog {
    db: SqlitePool,
    id: i64,
}

impl UpdateLog {
    pub async fn line(&self, text: impl AsRef<str>) {
        let mut text = text.as_ref().trim_end().to_string();
        text.push('\n');
        if let Err(e) = sqlx::query("UPDATE updates SET log = log || ? WHERE id = ?")
            .bind(text)
            .bind(self.id)
            .execute(&self.db)
            .await
        {
            tracing::warn!("failed to append update log: {e}");
        }
    }
}

/// Records a new update and runs `op` in the background, marking the update
/// as success or failed when it completes. Returns the update id immediately.
pub async fn spawn<F, Fut>(
    state: &AppState,
    user: &User,
    target_type: &str,
    target_name: &str,
    operation: &str,
    op: F,
) -> AppResult<Update>
where
    F: FnOnce(UpdateLog) -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    let update = sqlx::query_as::<_, Update>(
        "INSERT INTO updates (operation, target_type, target_name, status, username, started_at)
         VALUES (?, ?, ?, 'running', ?, ?) RETURNING *",
    )
    .bind(operation)
    .bind(target_type)
    .bind(target_name)
    .bind(&user.username)
    .bind(now())
    .fetch_one(&state.db)
    .await?;

    let log = UpdateLog {
        db: state.db.clone(),
        id: update.id,
    };
    tokio::spawn(async move {
        let db = log.db.clone();
        let id = log.id;
        let result = tokio::spawn(op(log.clone())).await;
        let status = match result {
            Ok(Ok(())) => "success",
            Ok(Err(e)) => {
                log.line(format!("ERROR: {e:#}")).await;
                "failed"
            }
            Err(e) => {
                log.line(format!("ERROR: task panicked: {e}")).await;
                "failed"
            }
        };
        let _ = sqlx::query("UPDATE updates SET status = ?, finished_at = ? WHERE id = ?")
            .bind(status)
            .bind(now())
            .bind(id)
            .execute(&db)
            .await;
    });

    Ok(update)
}

/// Any update still marked running at startup was interrupted by a restart.
pub async fn fail_interrupted(db: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE updates SET status = 'failed', finished_at = ?,
         log = log || 'ERROR: interrupted by server restart' || char(10)
         WHERE status = 'running'",
    )
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Deserialize)]
struct ListQuery {
    target_type: Option<String>,
    target_name: Option<String>,
    limit: Option<i64>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list))
        .route("/{id}", get(get_one))
}

async fn list(State(state): State<AppState>, Query(q): Query<ListQuery>) -> AppResult<Json<Vec<Update>>> {
    // The list omits logs to keep payloads small; fetch a single update for its log.
    let rows = sqlx::query_as::<_, Update>(
        "SELECT id, operation, target_type, target_name, status, '' AS log, username, started_at, finished_at
         FROM updates
         WHERE (?1 IS NULL OR target_type = ?1) AND (?2 IS NULL OR target_name = ?2)
         ORDER BY id DESC LIMIT ?3",
    )
    .bind(q.target_type)
    .bind(q.target_name)
    .bind(q.limit.unwrap_or(50).clamp(1, 500))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn get_one(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Update>> {
    Ok(Json(
        sqlx::query_as::<_, Update>("SELECT * FROM updates WHERE id = ?")
            .bind(id)
            .fetch_one(&state.db)
            .await?,
    ))
}
