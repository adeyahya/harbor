use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier},
};
use axum::{
    Json, Router,
    extract::{Request, State},
    middleware::Next,
    response::Response,
    routing::{get, post},
};
use axum_extra::extract::{
    CookieJar,
    cookie::{Cookie, SameSite},
};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    state::{AppState, now},
};

const COOKIE: &str = "harbor_session";
const SESSION_DAYS: i64 = 30;

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub username: String,
}

#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct AuthStatus {
    setup_required: bool,
    user: Option<User>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/status", get(status))
        .route("/setup", post(setup))
        .route("/login", post(login))
        .route("/logout", post(logout))
}

async fn user_count(state: &AppState) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await?)
}

async fn session_user(state: &AppState, jar: &CookieJar) -> AppResult<Option<User>> {
    let Some(token) = jar.get(COOKIE).map(|c| c.value().to_string()) else {
        return Ok(None);
    };
    Ok(sqlx::query_as::<_, User>(
        "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?",
    )
    .bind(token)
    .bind(now())
    .fetch_optional(&state.db)
    .await?)
}

async fn status(State(state): State<AppState>, jar: CookieJar) -> AppResult<Json<AuthStatus>> {
    Ok(Json(AuthStatus {
        setup_required: user_count(&state).await? == 0,
        user: session_user(&state, &jar).await?,
    }))
}

async fn start_session(state: &AppState, jar: CookieJar, user: &User) -> AppResult<CookieJar> {
    let token = hex::encode(rand::random::<[u8; 32]>());
    let expires = chrono::Utc::now() + chrono::Duration::days(SESSION_DAYS);
    sqlx::query("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(&token)
        .bind(user.id)
        .bind(expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .execute(&state.db)
        .await?;
    let cookie = Cookie::build((COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::days(SESSION_DAYS))
        .build();
    Ok(jar.add(cookie))
}

/// Creates the first (admin) user. Only allowed while no users exist.
async fn setup(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(creds): Json<Credentials>,
) -> AppResult<(CookieJar, Json<User>)> {
    if user_count(&state).await? > 0 {
        return Err(AppError::conflict("setup has already been completed"));
    }
    let username = creds.username.trim();
    if username.is_empty() || creds.password.len() < 8 {
        return Err(AppError::bad_request(
            "username is required and password must be at least 8 characters",
        ));
    }
    let hash = Argon2::default()
        .hash_password(creds.password.as_bytes())
        .map_err(|e| anyhow::anyhow!("hashing password: {e}"))?
        .to_string();
    let id =
        sqlx::query("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
            .bind(username)
            .bind(hash)
            .bind(now())
            .execute(&state.db)
            .await?
            .last_insert_rowid();
    let user = User {
        id,
        username: username.to_string(),
    };
    let jar = start_session(&state, jar, &user).await?;
    Ok((jar, Json(user)))
}

async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(creds): Json<Credentials>,
) -> AppResult<(CookieJar, Json<User>)> {
    let row: Option<(i64, String, String)> =
        sqlx::query_as("SELECT id, username, password_hash FROM users WHERE username = ?")
            .bind(creds.username.trim())
            .fetch_optional(&state.db)
            .await?;
    let invalid = || {
        AppError::new(
            axum::http::StatusCode::UNAUTHORIZED,
            "invalid username or password",
        )
    };
    let (id, username, hash) = row.ok_or_else(invalid)?;
    Argon2::default()
        .verify_password(creds.password.as_bytes(), hash.as_str())
        .map_err(|_| invalid())?;
    let user = User { id, username };
    let jar = start_session(&state, jar, &user).await?;
    Ok((jar, Json(user)))
}

async fn logout(State(state): State<AppState>, jar: CookieJar) -> AppResult<CookieJar> {
    if let Some(cookie) = jar.get(COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token = ?")
            .bind(cookie.value())
            .execute(&state.db)
            .await?;
    }
    Ok(jar.remove(Cookie::build(COOKIE).path("/")))
}

/// Rejects unauthenticated requests and makes the current [`User`] available
/// to handlers as an `Extension<User>`.
pub async fn require_user(
    State(state): State<AppState>,
    jar: CookieJar,
    mut req: Request,
    next: Next,
) -> AppResult<Response> {
    let user = session_user(&state, &jar)
        .await?
        .ok_or_else(AppError::unauthorized)?;
    req.extensions_mut().insert(user);
    Ok(next.run(req).await)
}
