//! Canvas organization: groups (ordered, collapsible) and pinned services.

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, put},
};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Serialize, sqlx::FromRow)]
pub struct Group {
    pub id: i64,
    pub name: String,
    pub position: i64,
    pub collapsed: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/groups", get(list_groups).post(create_group))
        .route("/groups/order", put(reorder_groups))
        .route("/groups/{id}", put(update_group).delete(delete_group))
        .route("/items/{kind}/{name}", put(update_item))
}

async fn list_groups(State(state): State<AppState>) -> AppResult<Json<Vec<Group>>> {
    Ok(Json(
        sqlx::query_as::<_, Group>("SELECT * FROM canvas_groups ORDER BY position, id")
            .fetch_all(&state.db)
            .await?,
    ))
}

#[derive(Deserialize)]
struct NewGroup {
    name: String,
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::bad_request("group name must be 1-60 characters"));
    }
    Ok(name.to_string())
}

async fn create_group(State(state): State<AppState>, Json(body): Json<NewGroup>) -> AppResult<Json<Group>> {
    let name = clean_name(&body.name)?;
    Ok(Json(
        sqlx::query_as::<_, Group>(
            "INSERT INTO canvas_groups (name, position) VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM canvas_groups)) RETURNING *",
        )
        .bind(name)
        .fetch_one(&state.db)
        .await?,
    ))
}

#[derive(Deserialize)]
struct GroupPatch {
    name: Option<String>,
    collapsed: Option<bool>,
}

async fn update_group(State(state): State<AppState>, Path(id): Path<i64>, Json(body): Json<GroupPatch>) -> AppResult<Json<Group>> {
    let name = body.name.as_deref().map(clean_name).transpose()?;
    sqlx::query_as::<_, Group>(
        "UPDATE canvas_groups SET name = COALESCE(?, name), collapsed = COALESCE(?, collapsed) WHERE id = ? RETURNING *",
    )
    .bind(name)
    .bind(body.collapsed)
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .map(Json)
    .ok_or_else(|| AppError::not_found("group not found"))
}

#[derive(Deserialize)]
struct Order {
    ids: Vec<i64>,
}

async fn reorder_groups(State(state): State<AppState>, Json(body): Json<Order>) -> AppResult<Json<Vec<Group>>> {
    let mut tx = state.db.begin().await?;
    for (position, id) in body.ids.iter().enumerate() {
        sqlx::query("UPDATE canvas_groups SET position = ? WHERE id = ?")
            .bind(position as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    list_groups(State(state)).await
}

/// Deletes the group; its services move back to the ungrouped section.
async fn delete_group(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<serde_json::Value>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE stacks SET group_id = NULL WHERE group_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE deployments SET group_id = NULL WHERE group_id = ?").bind(id).execute(&mut *tx).await?;
    let deleted = sqlx::query("DELETE FROM canvas_groups WHERE id = ?").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::not_found("group not found"));
    }
    Ok(Json(serde_json::json!({ "deleted": id })))
}

#[derive(Deserialize)]
struct ItemPatch {
    pinned: Option<bool>,
    /// `Some(None)` (JSON null) removes the service from its group.
    #[serde(default, deserialize_with = "double_option")]
    group_id: Option<Option<i64>>,
}

fn double_option<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<i64>>, D::Error> {
    Option::<i64>::deserialize(d).map(Some)
}

async fn update_item(
    State(state): State<AppState>,
    Path((kind, name)): Path<(String, String)>,
    Json(body): Json<ItemPatch>,
) -> AppResult<Json<serde_json::Value>> {
    const STACKS: &str = "UPDATE stacks SET pinned = COALESCE(?, pinned), group_id = CASE WHEN ? THEN ? ELSE group_id END WHERE name = ?";
    const DEPLOYMENTS: &str =
        "UPDATE deployments SET pinned = COALESCE(?, pinned), group_id = CASE WHEN ? THEN ? ELSE group_id END WHERE name = ?";
    let sql = match kind.as_str() {
        "stack" => STACKS,
        "deployment" => DEPLOYMENTS,
        _ => return Err(AppError::bad_request("kind must be 'stack' or 'deployment'")),
    };
    if let Some(Some(group)) = body.group_id {
        let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM canvas_groups WHERE id = ?").bind(group).fetch_optional(&state.db).await?;
        if exists.is_none() {
            return Err(AppError::not_found("group not found"));
        }
    }
    let result = sqlx::query(sql)
    .bind(body.pinned)
    .bind(body.group_id.is_some())
    .bind(body.group_id.flatten())
    .bind(&name)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(format!("{kind} '{name}' not found")));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}
