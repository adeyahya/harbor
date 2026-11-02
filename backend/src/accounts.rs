//! Git accounts: credentials stored once and used by every git-backed
//! service, instead of a token per service.

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, put},
};
use serde::{Deserialize, Serialize, Serializer};
use sqlx::SqlitePool;

use crate::{
    error::{AppError, AppResult},
    state::{AppState, now},
};

#[derive(Serialize, sqlx::FromRow)]
pub struct Account {
    pub id: i64,
    pub name: String,
    pub host: String,
    pub username: String,
    /// Never sent to clients; serialized only as whether one is set.
    #[serde(rename = "has_token", serialize_with = "is_set")]
    pub token: String,
    pub created_at: String,
}

fn is_set<S: Serializer>(value: &str, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_bool(!value.is_empty())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", put(update).delete(remove))
}

#[derive(Deserialize)]
struct AccountInput {
    name: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    username: String,
    /// Required on create; on update, absent or empty keeps the stored one.
    token: Option<String>,
}

fn clean(input: &AccountInput) -> AppResult<(String, String, String)> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::bad_request("name must be 1-60 characters"));
    }
    let host = normalize_host(if input.host.trim().is_empty() {
        "github.com"
    } else {
        &input.host
    });
    if host.is_empty() || host.contains(['/', ' ']) {
        return Err(AppError::bad_request(
            "host must be a hostname like github.com",
        ));
    }
    Ok((name, host, input.username.trim().to_string()))
}

fn normalize_host(h: &str) -> String {
    h.trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_lowercase()
}

async fn list(State(state): State<AppState>) -> AppResult<Json<Vec<Account>>> {
    Ok(Json(
        sqlx::query_as::<_, Account>("SELECT * FROM git_accounts ORDER BY name")
            .fetch_all(&state.db)
            .await?,
    ))
}

async fn create(
    State(state): State<AppState>,
    Json(input): Json<AccountInput>,
) -> AppResult<Json<Account>> {
    let (name, host, username) = clean(&input)?;
    let token = input
        .token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AppError::bad_request("token is required"))?;
    Ok(Json(
        sqlx::query_as::<_, Account>(
            "INSERT INTO git_accounts (name, host, username, token, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
        )
        .bind(name)
        .bind(host)
        .bind(username)
        .bind(token)
        .bind(now())
        .fetch_one(&state.db)
        .await?,
    ))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<AccountInput>,
) -> AppResult<Json<Account>> {
    let (name, host, username) = clean(&input)?;
    let token = input
        .token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    sqlx::query_as::<_, Account>(
        "UPDATE git_accounts SET name = ?, host = ?, username = ?, token = COALESCE(?, token) WHERE id = ? RETURNING *",
    )
    .bind(name)
    .bind(host)
    .bind(username)
    .bind(token)
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .map(Json)
    .ok_or_else(|| AppError::not_found("account not found"))
}

/// Deletes the account; services that chose it fall back to automatic.
async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE deployments SET git_account_id = NULL WHERE git_account_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE stacks SET git_account_id = NULL WHERE git_account_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let deleted = sqlx::query("DELETE FROM git_accounts WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::not_found("account not found"));
    }
    Ok(Json(serde_json::json!({ "deleted": id })))
}

/// Host of a git URL: `https://host/…`, `ssh://git@host/…` or `git@host:…`.
pub fn url_host(url: &str) -> Option<String> {
    let rest = match url.split_once("://") {
        Some((_, rest)) => rest,
        None => url.split_once('@').map(|(_, r)| r)?,
    };
    let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
    let host = rest.split(['/', ':']).next()?.to_lowercase();
    (!host.is_empty()).then_some(host)
}

/// The token to use for a repository: the chosen account's, else the account
/// for the repository's host, else the service's own legacy token.
pub async fn resolve_token(
    db: &SqlitePool,
    url: &str,
    account_id: Option<i64>,
    fallback: &str,
) -> String {
    let chosen = match account_id {
        Some(id) => sqlx::query_scalar::<_, String>("SELECT token FROM git_accounts WHERE id = ?")
            .bind(id)
            .fetch_optional(db)
            .await
            .ok()
            .flatten(),
        None => match url_host(url) {
            Some(host) => sqlx::query_scalar::<_, String>(
                "SELECT token FROM git_accounts WHERE host = ? ORDER BY id LIMIT 1",
            )
            .bind(host)
            .fetch_optional(db)
            .await
            .ok()
            .flatten(),
            None => None,
        },
    };
    chosen.unwrap_or_else(|| fallback.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts() {
        assert_eq!(
            url_host("https://github.com/a/b.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            url_host("https://tok@GitHub.com/a/b").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            url_host("git@gitlab.example.com:a/b.git").as_deref(),
            Some("gitlab.example.com")
        );
        assert_eq!(
            url_host("ssh://git@host.io:2222/a/b").as_deref(),
            Some("host.io")
        );
        assert_eq!(url_host("file:///tmp/repo.git"), None);
    }
}
