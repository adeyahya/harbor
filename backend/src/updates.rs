//! Every mutating operation (deploy, pull, start, ...) is recorded as an
//! "update": a row holding its status and a running log, so the UI can follow
//! long-running work and keep a history of what happened.

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::{sync::mpsc, task::AbortHandle};

use crate::{
    auth::User,
    error::{AppError, AppResult},
    state::{AppState, now},
};

#[derive(Clone, Serialize, sqlx::FromRow)]
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
    pub detail: String,
    /// Image the operation ran (a built tag or image ID), if any.
    pub artifact: String,
    /// Settings snapshot for rollback; only its presence is sent to clients.
    #[serde(rename = "has_snapshot", serialize_with = "is_set")]
    pub snapshot: String,
}

fn is_set<S: serde::Serializer>(value: &str, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_bool(!value.is_empty())
}

/// Handle given to a running operation for appending to its log.
///
/// Lines go through a channel to a writer task that flushes in batches;
/// builds can emit thousands of lines and each flush rewrites the log column.
#[derive(Clone)]
pub struct UpdateLog {
    db: SqlitePool,
    id: i64,
    tx: mpsc::UnboundedSender<String>,
    cancel: Arc<Mutex<Cancel>>,
}

/// Whether a running update may still be cancelled.
enum Cancel {
    Allowed,
    /// The operation is in a step that must not be cut short.
    Blocked,
    Requested {
        by: String,
    },
}

/// Updates that are still running, so they can be cancelled.
#[derive(Clone, Default)]
pub struct Running(Arc<Mutex<HashMap<i64, RunningTask>>>);

type RunningTask = (AbortHandle, Arc<Mutex<Cancel>>);

/// Keeps an update from being cancelled until dropped.
pub struct NoCancel(Arc<Mutex<Cancel>>);

impl Drop for NoCancel {
    fn drop(&mut self) {
        let mut c = self.0.lock().expect("cancel poisoned");
        if matches!(*c, Cancel::Blocked) {
            *c = Cancel::Allowed;
        }
    }
}

impl UpdateLog {
    pub fn id(&self) -> i64 {
        self.id
    }

    /// Blocks cancelling while the returned guard is alive, for steps that
    /// would leave things broken if aborted halfway (e.g. replacing a
    /// container). Fails if a cancel already came in.
    pub fn no_cancel(&self) -> anyhow::Result<NoCancel> {
        let mut c = self.cancel.lock().expect("cancel poisoned");
        if let Cancel::Requested { by } = &*c {
            anyhow::bail!("cancelled by {by}");
        }
        *c = Cancel::Blocked;
        Ok(NoCancel(self.cancel.clone()))
    }

    pub async fn line(&self, text: impl AsRef<str>) {
        let mut text = text.as_ref().trim_end().to_string();
        text.push('\n');
        let _ = self.tx.send(text);
    }

    /// Records what this operation deployed so it can be rolled back to.
    pub async fn set_artifact(&self, artifact: &str, snapshot: &str) {
        let _ = sqlx::query("UPDATE updates SET artifact = ?, snapshot = ? WHERE id = ?")
            .bind(artifact)
            .bind(snapshot)
            .bind(self.id)
            .execute(&self.db)
            .await;
    }

    /// Short summary shown next to the operation, e.g. the commit being built.
    pub async fn set_detail(&self, detail: &str) {
        let _ = sqlx::query("UPDATE updates SET detail = ? WHERE id = ?")
            .bind(detail)
            .bind(self.id)
            .execute(&self.db)
            .await;
    }
}

async fn append(db: &SqlitePool, id: i64, text: &str) {
    if let Err(e) = sqlx::query("UPDATE updates SET log = log || ? WHERE id = ?")
        .bind(text)
        .bind(id)
        .execute(db)
        .await
    {
        tracing::warn!("failed to append update log: {e}");
    }
}

/// Drains log lines until every sender is dropped, flushing every 150ms or
/// 64 lines, whichever comes first.
async fn write_logs(db: SqlitePool, id: i64, mut rx: mpsc::UnboundedReceiver<String>) {
    let mut buf = String::new();
    let mut lines = 0;
    let mut tick = tokio::time::interval(Duration::from_millis(150));
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(text) => {
                    buf.push_str(&text);
                    lines += 1;
                    if lines >= 64 {
                        append(&db, id, &buf).await;
                        buf.clear();
                        lines = 0;
                    }
                }
                None => break,
            },
            _ = tick.tick() => {
                if !buf.is_empty() {
                    append(&db, id, &buf).await;
                    buf.clear();
                    lines = 0;
                }
            }
        }
    }
    if !buf.is_empty() {
        append(&db, id, &buf).await;
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

    let db = state.db.clone();
    let id = update.id;
    let (tx, rx) = mpsc::unbounded_channel();
    let writer = tokio::spawn(write_logs(db.clone(), id, rx));
    let cancel = Arc::new(Mutex::new(Cancel::Allowed));
    let log = UpdateLog {
        db: db.clone(),
        id,
        tx,
        cancel: cancel.clone(),
    };
    let running = state.running.clone();
    // Hold the registry while spawning so a cancel can't miss the task.
    let task = {
        let mut map = running.0.lock().expect("running poisoned");
        let task = tokio::spawn(op(log.clone()));
        map.insert(id, (task.abort_handle(), cancel.clone()));
        task
    };
    tokio::spawn(async move {
        let result = task.await;
        running.0.lock().expect("running poisoned").remove(&id);
        let cancelled_by = match &*cancel.lock().expect("cancel poisoned") {
            Cancel::Requested { by } => Some(by.clone()),
            _ => None,
        };
        let status = match result {
            Ok(Ok(())) => "success",
            // Aborted, or stopped itself at a no_cancel() after the request.
            _ if let Some(by) = cancelled_by => {
                log.line(format!("ERROR: cancelled by {by}")).await;
                "cancelled"
            }
            Ok(Err(e)) => {
                log.line(format!("ERROR: {e:#}")).await;
                "failed"
            }
            Err(e) => {
                log.line(format!("ERROR: task panicked: {e}")).await;
                "failed"
            }
        };
        // Flush all output before the update is marked finished.
        drop(log);
        let _ = writer.await;
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
        .route("/{id}/cancel", post(cancel))
}

/// Aborts a running update. Its child processes (git, docker build, compose)
/// are killed as the task is dropped, and its resource lock is released so
/// queued operations go ahead.
async fn cancel(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<i64>,
) -> AppResult<Json<Update>> {
    {
        let map = state.running.0.lock().expect("running poisoned");
        let Some((handle, cancel)) = map.get(&id) else {
            return Err(AppError::conflict("this operation is not running"));
        };
        let mut c = cancel.lock().expect("cancel poisoned");
        match &*c {
            Cancel::Blocked => {
                return Err(AppError::conflict(
                    "this operation is replacing its container and can't be cancelled now; try again in a moment",
                ));
            }
            Cancel::Requested { .. } => {}
            Cancel::Allowed => {
                *c = Cancel::Requested {
                    by: user.username.clone(),
                };
                handle.abort();
            }
        }
    }
    get_one(State(state), Path(id)).await
}

async fn list(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Update>>> {
    // The list omits logs to keep payloads small; fetch a single update for its log.
    let rows = sqlx::query_as::<_, Update>(
        "SELECT id, operation, target_type, target_name, status, '' AS log, username, started_at, finished_at, detail,
                artifact, snapshot
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
