//! Backup destinations: Google Drive (OAuth with the user's own client), a
//! folder on Harbor's filesystem, or any rclone remote (S3, B2, Dropbox,
//! OneDrive, SFTP, ...). Each can store, fetch and delete backup archives.

use std::{
    path::{Path as FsPath, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use anyhow::{Context, anyhow, bail};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    response::Redirect,
    routing::{get, post, put},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::{
    error::{AppError, AppResult},
    state::{AppState, now},
    updates::UpdateLog,
};

const GOOGLE_AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";
const DRIVE: &str = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
/// Only files Harbor creates; Harbor can't see anything else in the Drive.
const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
/// Upload chunk size; Drive wants multiples of 256 KiB.
const CHUNK: usize = 32 * 256 * 1024;
pub const RCLONE_IMAGE: &str = "rclone/rclone:1.71";

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent("harbor")
        .build()
        .expect("http client")
});

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    // local
    pub path: String,
    // gdrive
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
    /// Name of the Drive folder backups go in.
    pub folder_name: String,
    pub folder_id: String,
    /// Email of the connected Google account.
    pub account: String,
    pub oauth_state: String,
    pub redirect_uri: String,
    // rclone
    pub rclone_config: String,
    /// `remote:path` backups go under.
    pub remote: String,
}

#[derive(Clone, sqlx::FromRow)]
pub struct Destination {
    pub id: i64,
    pub name: String,
    pub kind: String,
    #[sqlx(json)]
    pub config: Config,
    pub created_at: String,
}

/// What clients see: settings without secrets.
#[derive(Serialize)]
pub struct DestinationView {
    id: i64,
    name: String,
    kind: String,
    created_at: String,
    path: String,
    client_id: String,
    has_client_secret: bool,
    folder_name: String,
    account: String,
    /// Google Drive: authorized; others: always.
    connected: bool,
    remote: String,
    has_rclone_config: bool,
}

impl From<Destination> for DestinationView {
    fn from(d: Destination) -> Self {
        let c = d.config;
        Self {
            connected: d.kind != "gdrive" || !c.refresh_token.is_empty(),
            id: d.id,
            name: d.name,
            kind: d.kind,
            created_at: d.created_at,
            path: c.path,
            client_id: c.client_id,
            has_client_secret: !c.client_secret.is_empty(),
            folder_name: c.folder_name,
            account: c.account,
            remote: c.remote,
            has_rclone_config: !c.rclone_config.is_empty(),
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", put(update).delete(remove))
        .route("/{id}/test", post(test))
        .route("/{id}/google/authorize", post(google_authorize))
        .route("/{id}/google/code", post(google_code))
        .route("/google/callback", get(google_callback))
}

pub async fn get_destination(db: &SqlitePool, id: i64) -> AppResult<Destination> {
    sqlx::query_as::<_, Destination>("SELECT * FROM backup_destinations WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("backup destination not found"))
}

async fn save_config(db: &SqlitePool, id: i64, config: &Config) -> anyhow::Result<()> {
    sqlx::query("UPDATE backup_destinations SET config = ? WHERE id = ?")
        .bind(serde_json::to_string(config)?)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

async fn list(State(state): State<AppState>) -> AppResult<Json<Vec<DestinationView>>> {
    let rows = sqlx::query_as::<_, Destination>("SELECT * FROM backup_destinations ORDER BY name").fetch_all(&state.db).await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

#[derive(Deserialize)]
struct DestinationInput {
    name: String,
    kind: Option<String>,
    #[serde(default)]
    path: String,
    #[serde(default)]
    client_id: String,
    /// Absent or empty keeps the stored one.
    client_secret: Option<String>,
    #[serde(default)]
    folder_name: String,
    #[serde(default)]
    remote: String,
    /// Absent or empty keeps the stored one.
    rclone_config: Option<String>,
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// Applies `input` on top of `config`, validating the result for `kind`.
fn apply(kind: &str, mut config: Config, input: &DestinationInput) -> AppResult<Config> {
    match kind {
        "local" => {
            let path = input.path.trim();
            if !path.starts_with('/') {
                return Err(AppError::bad_request("the folder must be an absolute path"));
            }
            config.path = path.trim_end_matches('/').to_string();
            if config.path.is_empty() {
                return Err(AppError::bad_request("backups can't go in /"));
            }
        }
        "gdrive" => {
            let client_id = input.client_id.trim();
            if client_id.is_empty() {
                return Err(AppError::bad_request("a Google OAuth client ID is required"));
            }
            if client_id != config.client_id {
                // Tokens belong to the old client.
                config.refresh_token.clear();
                config.account.clear();
            }
            config.client_id = client_id.to_string();
            if let Some(secret) = non_empty(&input.client_secret) {
                config.client_secret = secret;
            }
            if config.client_secret.is_empty() {
                return Err(AppError::bad_request("a Google OAuth client secret is required"));
            }
            let folder = input.folder_name.trim();
            let folder = if folder.is_empty() { "Harbor backups" } else { folder };
            if folder != config.folder_name {
                config.folder_id.clear();
            }
            config.folder_name = folder.to_string();
        }
        "rclone" => {
            let remote = input.remote.trim();
            if !remote.contains(':') || remote.starts_with(':') {
                return Err(AppError::bad_request("the remote must look like name:path, e.g. s3:my-bucket/harbor"));
            }
            config.remote = remote.to_string();
            if let Some(conf) = non_empty(&input.rclone_config) {
                config.rclone_config = conf;
            }
            let name = remote.split(':').next().unwrap_or_default();
            if !config.rclone_config.contains(&format!("[{name}]")) {
                return Err(AppError::bad_request(format!("the rclone config needs a [{name}] section for the remote")));
            }
        }
        _ => return Err(AppError::bad_request("kind must be gdrive, local or rclone")),
    }
    Ok(config)
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::bad_request("name must be 1-60 characters"));
    }
    Ok(name.to_string())
}

async fn create(State(state): State<AppState>, Json(input): Json<DestinationInput>) -> AppResult<Json<DestinationView>> {
    let name = clean_name(&input.name)?;
    let kind = input.kind.clone().unwrap_or_default();
    let config = apply(&kind, Config::default(), &input)?;
    let d = sqlx::query_as::<_, Destination>(
        "INSERT INTO backup_destinations (name, kind, config, created_at) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .bind(name)
    .bind(&kind)
    .bind(serde_json::to_string(&config).map_err(anyhow::Error::from)?)
    .bind(now())
    .fetch_one(&state.db)
    .await?;
    Ok(Json(d.into()))
}

async fn update(State(state): State<AppState>, Path(id): Path<i64>, Json(input): Json<DestinationInput>) -> AppResult<Json<DestinationView>> {
    let d = get_destination(&state.db, id).await?;
    let name = clean_name(&input.name)?;
    let config = apply(&d.kind, d.config, &input)?;
    let d = sqlx::query_as::<_, Destination>("UPDATE backup_destinations SET name = ?, config = ? WHERE id = ? RETURNING *")
        .bind(name)
        .bind(serde_json::to_string(&config).map_err(anyhow::Error::from)?)
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(d.into()))
}

/// Deletes the destination and its jobs. Files already uploaded stay where they are.
async fn remove(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let deleted = sqlx::query("DELETE FROM backup_destinations WHERE id = ?").bind(id).execute(&state.db).await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::not_found("backup destination not found"));
    }
    Ok(Json(json!({ "deleted": id })))
}

/// Checks the destination is reachable and writable.
async fn test(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    let d = get_destination(&state.db, id).await?;
    let message = match d.kind.as_str() {
        "local" => {
            let dir = PathBuf::from(&d.config.path);
            tokio::fs::create_dir_all(&dir).await.with_context(|| format!("creating {}", dir.display()))?;
            let probe = dir.join(".harbor-write-test");
            tokio::fs::write(&probe, b"ok").await.with_context(|| format!("writing to {}", dir.display()))?;
            let _ = tokio::fs::remove_file(&probe).await;
            format!("{} is writable", dir.display())
        }
        "gdrive" => {
            let token = google_access_token(&d.config).await?;
            let mut config = d.config.clone();
            let folder = drive_folder(&state.db, d.id, &mut config, &token).await?;
            format!("Connected as {}; backups go in the “{}” folder ({folder})", config.account, config.folder_name)
        }
        "rclone" => {
            rclone(&state, &d.config, &["mkdir", &d.config.remote]).await?;
            let listing = rclone(&state, &d.config, &["lsf", "--max-depth", "1", &d.config.remote]).await?;
            let files = listing.lines().count();
            format!("{} is reachable ({files} entr{} there)", d.config.remote, if files == 1 { "y" } else { "ies" })
        }
        _ => return Err(AppError::bad_request("unknown destination kind")),
    };
    Ok(Json(json!({ "message": message })))
}

// ---- Google Drive ------------------------------------------------------------

#[derive(Deserialize)]
struct AuthorizeInput {
    /// Where Google sends the browser back to; must be registered on the client.
    redirect_uri: String,
}

async fn google_authorize(State(state): State<AppState>, Path(id): Path<i64>, Json(input): Json<AuthorizeInput>) -> AppResult<Json<Value>> {
    let d = get_destination(&state.db, id).await?;
    if d.kind != "gdrive" {
        return Err(AppError::bad_request("not a Google Drive destination"));
    }
    let redirect = input.redirect_uri.trim();
    if !(redirect.starts_with("http://") || redirect.starts_with("https://")) {
        return Err(AppError::bad_request("redirect URI must be an http(s) URL"));
    }
    let mut config = d.config;
    config.oauth_state = hex::encode(rand::random::<[u8; 16]>());
    config.redirect_uri = redirect.to_string();
    save_config(&state.db, id, &config).await?;
    let url = reqwest::Url::parse_with_params(
        GOOGLE_AUTH,
        &[
            ("client_id", config.client_id.as_str()),
            ("redirect_uri", redirect),
            ("response_type", "code"),
            ("scope", DRIVE_SCOPE),
            // A refresh token, every time (Google only sends one on consent).
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("state", config.oauth_state.as_str()),
        ],
    )
    .map_err(|e| AppError::bad_request(e.to_string()))?;
    Ok(Json(json!({ "url": url.to_string() })))
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// Google redirects here after consent when Harbor's own URL is the redirect URI.
async fn google_callback(State(state): State<AppState>, Query(q): Query<CallbackQuery>) -> Redirect {
    let back = |id: Option<i64>, error: Option<String>| {
        Redirect::to(&match (id, error) {
            (_, Some(e)) => format!("/settings?backup_error={}#backups", urlencode(&e)),
            (Some(id), None) => format!("/settings?backup_connected={id}#backups"),
            (None, None) => "/settings#backups".to_string(),
        })
    };
    if let Some(e) = q.error {
        return back(None, Some(format!("Google sign-in failed: {e}")));
    }
    let (Some(code), Some(oauth_state)) = (q.code, q.state) else {
        return back(None, Some("Google didn't return an authorization code".into()));
    };
    let found = sqlx::query_as::<_, Destination>(
        "SELECT * FROM backup_destinations WHERE kind = 'gdrive' AND json_extract(config, '$.oauth_state') = ?",
    )
    .bind(&oauth_state)
    .fetch_optional(&state.db)
    .await;
    let d = match found {
        Ok(Some(d)) if !oauth_state.is_empty() => d,
        _ => return back(None, Some("this sign-in link expired; connect again".into())),
    };
    match finish_google(&state.db, d, &code).await {
        Ok(id) => back(Some(id), None),
        Err(e) => back(None, Some(format!("{e:#}"))),
    }
}

fn urlencode(s: &str) -> String {
    reqwest::Url::parse_with_params("http://x/", &[("v", s)])
        .ok()
        .and_then(|u| u.query().map(|q| q.trim_start_matches("v=").to_string()))
        .unwrap_or_default()
}

#[derive(Deserialize)]
struct CodeInput {
    /// The code, or the whole URL Google redirected to.
    code: String,
}

/// For redirect URIs Google can't reach Harbor through (e.g. `http://localhost`
/// with a desktop OAuth client): the user pastes the address they landed on.
async fn google_code(State(state): State<AppState>, Path(id): Path<i64>, Json(input): Json<CodeInput>) -> AppResult<Json<DestinationView>> {
    let d = get_destination(&state.db, id).await?;
    let raw = input.code.trim();
    let code = match reqwest::Url::parse(raw) {
        Ok(url) => {
            let param = |k: &str| url.query_pairs().find(|(name, _)| name == k).map(|(_, v)| v.into_owned());
            if let Some(e) = param("error") {
                return Err(AppError::bad_request(format!("Google sign-in failed: {e}")));
            }
            if param("state").is_some_and(|s| s != d.config.oauth_state) {
                return Err(AppError::bad_request("that address is from an older sign-in; connect again"));
            }
            param("code").ok_or_else(|| AppError::bad_request("that address has no code= parameter"))?
        }
        Err(_) => raw.to_string(),
    };
    if code.is_empty() {
        return Err(AppError::bad_request("paste the code or the address Google sent you to"));
    }
    finish_google(&state.db, d, &code).await?;
    Ok(Json(get_destination(&state.db, id).await?.into()))
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

async fn google_error(res: reqwest::Response) -> anyhow::Error {
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v["error_description"]
                .as_str()
                .or(v["error"]["message"].as_str())
                .or(v["error"].as_str())
                .map(String::from)
        })
        .unwrap_or(body);
    anyhow!("Google returned {status}: {}", message.trim())
}

/// Exchanges an authorization code for tokens and stores them.
async fn finish_google(db: &SqlitePool, d: Destination, code: &str) -> anyhow::Result<i64> {
    let mut config = d.config;
    let res = HTTP
        .post(GOOGLE_TOKEN)
        .form(&[
            ("code", code),
            ("client_id", &config.client_id),
            ("client_secret", &config.client_secret),
            ("redirect_uri", &config.redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(google_error(res).await);
    }
    let tokens: TokenResponse = res.json().await?;
    config.refresh_token = tokens
        .refresh_token
        .ok_or_else(|| anyhow!("Google didn't return a refresh token; remove Harbor's access in your Google account and connect again"))?;
    config.oauth_state.clear();
    config.account = drive_account(&tokens.access_token).await.unwrap_or_default();
    config.folder_id.clear();
    save_config(db, d.id, &config).await?;
    Ok(d.id)
}

async fn drive_account(token: &str) -> anyhow::Result<String> {
    let res = HTTP.get(format!("{DRIVE}/about")).query(&[("fields", "user(emailAddress)")]).bearer_auth(token).send().await?;
    if !res.status().is_success() {
        return Err(google_error(res).await);
    }
    let v: Value = res.json().await?;
    Ok(v["user"]["emailAddress"].as_str().unwrap_or_default().to_string())
}

async fn google_access_token(config: &Config) -> anyhow::Result<String> {
    if config.refresh_token.is_empty() {
        bail!("this Google Drive destination isn't connected yet; connect it in Settings → Backups");
    }
    let res = HTTP
        .post(GOOGLE_TOKEN)
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("client_secret", &config.client_secret),
            ("refresh_token", &config.refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?;
    if !res.status().is_success() {
        let e = google_error(res).await;
        return Err(e.context("refreshing Google access (if it was revoked, connect the destination again)"));
    }
    Ok(res.json::<TokenResponse>().await?.access_token)
}

/// The ID of the backup folder, creating it if needed. With the drive.file
/// scope Harbor only sees folders it created itself.
async fn drive_folder(db: &SqlitePool, id: i64, config: &mut Config, token: &str) -> anyhow::Result<String> {
    if !config.folder_id.is_empty() {
        let res = HTTP
            .get(format!("{DRIVE}/files/{}", config.folder_id))
            .query(&[("fields", "id,trashed")])
            .bearer_auth(token)
            .send()
            .await?;
        if res.status().is_success() && !res.json::<Value>().await?["trashed"].as_bool().unwrap_or(false) {
            return Ok(config.folder_id.clone());
        }
    }
    let q = format!(
        "name = '{}' and mimeType = '{FOLDER_MIME}' and trashed = false and 'root' in parents",
        config.folder_name.replace('\\', "\\\\").replace('\'', "\\'")
    );
    let res = HTTP.get(format!("{DRIVE}/files")).query(&[("q", q.as_str()), ("fields", "files(id)")]).bearer_auth(token).send().await?;
    if !res.status().is_success() {
        return Err(google_error(res).await);
    }
    let found: Value = res.json().await?;
    let folder = match found["files"][0]["id"].as_str() {
        Some(id) => id.to_string(),
        None => {
            let res = HTTP
                .post(format!("{DRIVE}/files"))
                .query(&[("fields", "id")])
                .bearer_auth(token)
                .json(&json!({ "name": config.folder_name, "mimeType": FOLDER_MIME }))
                .send()
                .await?;
            if !res.status().is_success() {
                return Err(google_error(res).await);
            }
            res.json::<Value>().await?["id"].as_str().ok_or_else(|| anyhow!("Drive didn't return the folder's ID"))?.to_string()
        }
    };
    config.folder_id = folder.clone();
    save_config(db, id, config).await?;
    Ok(folder)
}

/// Resumable upload, so large archives survive dropped connections.
async fn drive_upload(token: &str, folder: &str, file: &FsPath, name: &str, log: &UpdateLog) -> anyhow::Result<String> {
    let size = tokio::fs::metadata(file).await?.len();
    let res = HTTP
        .post(DRIVE_UPLOAD)
        .query(&[("uploadType", "resumable"), ("fields", "id")])
        .bearer_auth(token)
        .header("X-Upload-Content-Type", "application/gzip")
        .header("X-Upload-Content-Length", size)
        .json(&json!({ "name": name, "parents": [folder] }))
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(google_error(res).await);
    }
    let session = res
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|l| l.to_str().ok())
        .ok_or_else(|| anyhow!("Drive didn't return an upload URL"))?
        .to_string();

    let mut f = tokio::fs::File::open(file).await?;
    let mut buf = vec![0u8; CHUNK];
    let mut offset: u64 = 0;
    let mut failures = 0;
    let mut reported = 0;
    loop {
        f.seek(std::io::SeekFrom::Start(offset)).await?;
        let mut len = 0;
        while len < CHUNK {
            let n = f.read(&mut buf[len..]).await?;
            if n == 0 {
                break;
            }
            len += n;
        }
        let end = offset + len as u64;
        let range = if len == 0 { format!("bytes */{size}") } else { format!("bytes {offset}-{}/{size}", end - 1) };
        let sent = HTTP
            .put(&session)
            .header(reqwest::header::CONTENT_RANGE, range)
            .header(reqwest::header::CONTENT_LENGTH, len)
            .body(buf[..len].to_vec())
            .timeout(Duration::from_secs(300))
            .send()
            .await;
        let res = match sent {
            Ok(res) if res.status().is_server_error() => Err(google_error(res).await),
            Ok(res) => Ok(res),
            Err(e) => Err(e.into()),
        };
        let res = match res {
            Ok(res) => {
                failures = 0;
                res
            }
            Err(e) if failures < 5 => {
                failures += 1;
                log.line(format!("upload interrupted ({e:#}); retrying")).await;
                tokio::time::sleep(Duration::from_secs(2u64.pow(failures))).await;
                // Ask Drive how much it has, then continue from there.
                offset = drive_received(&session, size).await.unwrap_or(offset);
                continue;
            }
            Err(e) => return Err(e.context("uploading to Google Drive")),
        };
        match res.status().as_u16() {
            200 | 201 => {
                let v: Value = res.json().await?;
                return v["id"].as_str().map(String::from).ok_or_else(|| anyhow!("Drive didn't return the file's ID"));
            }
            308 => {
                offset = received_from(res.headers()).unwrap_or(0);
                let pct = offset * 100 / size.max(1);
                if pct >= reported + 20 {
                    reported = pct - pct % 20;
                    log.line(format!("uploaded {} of {} ({pct}%)", human(offset), human(size))).await;
                }
            }
            _ => return Err(google_error(res).await),
        }
    }
}

/// Bytes Drive has received in a resumable session (its `Range: bytes=0-N`).
fn received_from(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let range = headers.get(reqwest::header::RANGE)?.to_str().ok()?;
    range.rsplit('-').next()?.parse::<u64>().ok().map(|n| n + 1)
}

async fn drive_received(session: &str, size: u64) -> Option<u64> {
    let res = HTTP
        .put(session)
        .header(reqwest::header::CONTENT_RANGE, format!("bytes */{size}"))
        .header(reqwest::header::CONTENT_LENGTH, 0)
        .send()
        .await
        .ok()?;
    (res.status().as_u16() == 308).then(|| received_from(res.headers()).unwrap_or(0))
}

pub fn human(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{n} B") } else { format!("{v:.1} {}", units[i]) }
}

// ---- rclone ------------------------------------------------------------------

/// `remote:path` joined with a file name.
fn rclone_path(remote: &str, file: &str) -> String {
    if remote.ends_with(':') || remote.ends_with('/') { format!("{remote}{file}") } else { format!("{remote}/{file}") }
}

/// The exec command for an rclone invocation inside the helper. The config is
/// passed in the exec's environment so it never lands in a container's settings.
fn rclone_cmd(args: &[&str]) -> Vec<String> {
    let mut cmd = vec![
        "sh".to_string(),
        "-c".into(),
        r#"umask 077; printf '%s\n' "$HARBOR_RCLONE_CONFIG" > /tmp/rclone.conf && exec rclone --config /tmp/rclone.conf "$@""#.into(),
        "rclone".into(),
    ];
    cmd.extend(args.iter().map(|a| a.to_string()));
    cmd
}

/// Runs an rclone command that only produces a little output.
/// Quick commands (checks, deletes) give up sooner than rclone's defaults.
async fn rclone(state: &AppState, config: &Config, args: &[&str]) -> anyhow::Result<String> {
    let helper = crate::backups::Helper::start(state, crate::backups::HelperSpec::rclone()).await?;
    let mut args = args.to_vec();
    args.extend(["--retries", "1", "--low-level-retries", "2", "--contimeout", "15s"]);
    let (out, stderr, code) = helper.exec(rclone_cmd(&args), env(config), None, None).await?;
    if code != 0 {
        bail!("rclone failed: {}", stderr.trim());
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn env(config: &Config) -> Vec<String> {
    vec![format!("HARBOR_RCLONE_CONFIG={}", config.rclone_config)]
}

// ---- Operations used by backups ----------------------------------------------

impl Destination {
    /// Stores `file` as `name`; returns the reference used to find it again.
    pub async fn upload(&self, state: &AppState, file: &FsPath, name: &str, log: &UpdateLog) -> anyhow::Result<String> {
        match self.kind.as_str() {
            "local" => {
                let dir = PathBuf::from(&self.config.path);
                tokio::fs::create_dir_all(&dir).await.with_context(|| format!("creating {}", dir.display()))?;
                let partial = dir.join(format!(".{name}.partial"));
                tokio::fs::copy(file, &partial).await.with_context(|| format!("writing to {}", dir.display()))?;
                tokio::fs::rename(&partial, dir.join(name)).await?;
                log.line(format!("saved to {}", dir.join(name).display())).await;
                Ok(name.to_string())
            }
            "gdrive" => {
                let token = google_access_token(&self.config).await?;
                let mut config = self.config.clone();
                let folder = drive_folder(&state.db, self.id, &mut config, &token).await?;
                let id = drive_upload(&token, &folder, file, name, log).await?;
                log.line(format!("uploaded to Google Drive: {}/{name}", config.folder_name)).await;
                Ok(id)
            }
            "rclone" => {
                let target = rclone_path(&self.config.remote, name);
                let helper = crate::backups::Helper::start(state, crate::backups::HelperSpec::rclone()).await?;
                let input = tokio::fs::File::open(file).await?;
                let (_, stderr, code) = helper.exec(rclone_cmd(&["rcat", &target]), env(&self.config), Some(input), None).await?;
                if code != 0 {
                    bail!("rclone upload failed: {}", stderr.trim());
                }
                log.line(format!("uploaded to {target}")).await;
                Ok(name.to_string())
            }
            other => bail!("unknown destination kind {other}"),
        }
    }

    /// Fetches a stored backup into `to`.
    pub async fn download(&self, state: &AppState, remote_ref: &str, to: &FsPath) -> anyhow::Result<()> {
        match self.kind.as_str() {
            "local" => {
                let src = PathBuf::from(&self.config.path).join(remote_ref);
                tokio::fs::copy(&src, to).await.with_context(|| format!("reading {}", src.display()))?;
            }
            "gdrive" => {
                let token = google_access_token(&self.config).await?;
                let res = HTTP.get(format!("{DRIVE}/files/{remote_ref}")).query(&[("alt", "media")]).bearer_auth(&token).send().await?;
                if !res.status().is_success() {
                    return Err(google_error(res).await.context("downloading from Google Drive"));
                }
                let mut out = tokio::fs::File::create(to).await?;
                let mut body = res.bytes_stream();
                while let Some(chunk) = body.next().await {
                    out.write_all(&chunk?).await?;
                }
                out.flush().await?;
            }
            "rclone" => {
                let source = rclone_path(&self.config.remote, remote_ref);
                let helper = crate::backups::Helper::start(state, crate::backups::HelperSpec::rclone()).await?;
                let out = tokio::fs::File::create(to).await?;
                let (_, stderr, code) = helper.exec(rclone_cmd(&["cat", &source]), env(&self.config), None, Some(out)).await?;
                if code != 0 {
                    bail!("rclone download failed: {}", stderr.trim());
                }
            }
            other => bail!("unknown destination kind {other}"),
        }
        Ok(())
    }

    /// Deletes a stored backup; one that's already gone counts as deleted.
    pub async fn delete(&self, state: &AppState, remote_ref: &str) -> anyhow::Result<()> {
        match self.kind.as_str() {
            "local" => match tokio::fs::remove_file(PathBuf::from(&self.config.path).join(remote_ref)).await {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
                _ => Ok(()),
            },
            "gdrive" => {
                let token = google_access_token(&self.config).await?;
                let res = HTTP.delete(format!("{DRIVE}/files/{remote_ref}")).bearer_auth(&token).send().await?;
                if res.status().is_success() || res.status() == reqwest::StatusCode::NOT_FOUND {
                    Ok(())
                } else {
                    Err(google_error(res).await)
                }
            }
            "rclone" => {
                let target = rclone_path(&self.config.remote, remote_ref);
                match rclone(state, &self.config, &["deletefile", &target]).await {
                    Err(e) if !format!("{e}").contains("not found") => Err(e),
                    _ => Ok(()),
                }
            }
            other => bail!("unknown destination kind {other}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: &str) -> DestinationInput {
        DestinationInput {
            name: "x".into(),
            kind: Some(kind.into()),
            path: String::new(),
            client_id: String::new(),
            client_secret: None,
            folder_name: String::new(),
            remote: String::new(),
            rclone_config: None,
        }
    }

    #[test]
    fn validates_local_paths() {
        let mut i = input("local");
        i.path = "backups".into();
        assert!(apply("local", Config::default(), &i).is_err());
        i.path = "/var/lib/harbor/backups/".into();
        assert_eq!(apply("local", Config::default(), &i).unwrap().path, "/var/lib/harbor/backups");
    }

    #[test]
    fn keeps_google_secret_and_resets_tokens_on_new_client() {
        let mut i = input("gdrive");
        i.client_id = "a".into();
        i.client_secret = Some("s".into());
        let mut c = apply("gdrive", Config::default(), &i).unwrap();
        assert_eq!(c.folder_name, "Harbor backups");
        c.refresh_token = "r".into();
        i.client_secret = None;
        assert_eq!(apply("gdrive", c.clone(), &i).unwrap().refresh_token, "r");
        i.client_id = "b".into();
        assert_eq!(apply("gdrive", c, &i).unwrap().refresh_token, "");
    }

    #[test]
    fn rclone_needs_a_matching_section() {
        let mut i = input("rclone");
        i.remote = "b2:bucket/harbor".into();
        i.rclone_config = Some("[s3]\ntype = s3".into());
        assert!(apply("rclone", Config::default(), &i).is_err());
        i.rclone_config = Some("[b2]\ntype = b2".into());
        assert!(apply("rclone", Config::default(), &i).is_ok());
        assert_eq!(rclone_path("b2:", "f.tar.gz"), "b2:f.tar.gz");
        assert_eq!(rclone_path("b2:bucket", "f.tar.gz"), "b2:bucket/f.tar.gz");
    }

    #[test]
    fn parses_drive_ranges() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(reqwest::header::RANGE, "bytes=0-8388607".parse().unwrap());
        assert_eq!(received_from(&h), Some(8388608));
    }
}
