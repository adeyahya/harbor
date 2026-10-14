mod assets;
mod auth;
mod deployments;
mod docker;
mod error;
mod git;
mod import;
mod ports;
mod process;
mod stacks;
mod state;
mod system;
mod updates;

use std::{net::SocketAddr, path::PathBuf, str::FromStr, sync::Arc};

use anyhow::Context;
use axum::{Router, middleware, routing::get};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use tokio::sync::RwLock;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "harbor=info,tower_http=warn".into()),
        )
        .init();

    let data_dir = PathBuf::from(std::env::var("HARBOR_DATA_DIR").unwrap_or_else(|_| "./data".into()));
    let addr = SocketAddr::from_str(
        &std::env::var("HARBOR_ADDR").unwrap_or_else(|_| "127.0.0.1:9120".into()),
    )
    .context("invalid HARBOR_ADDR")?;
    std::fs::create_dir_all(data_dir.join("stacks"))
        .with_context(|| format!("creating data dir {}", data_dir.display()))?;

    let db = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(data_dir.join("harbor.db"))
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal)
                .foreign_keys(true),
        )
        .await
        .context("opening database")?;
    sqlx::migrate!().run(&db).await.context("running migrations")?;
    updates::fail_interrupted(&db).await?;

    let docker = connect_docker().context("connecting to Docker")?;
    match docker.ping().await {
        Ok(_) => tracing::info!("connected to Docker"),
        Err(e) => tracing::warn!("Docker is not reachable yet: {e}"),
    }

    let host_stats = Arc::new(RwLock::new(Default::default()));
    system::spawn_collector(host_stats.clone());
    std::fs::create_dir_all(data_dir.join("builds"))?;

    let state = AppState {
        db,
        docker,
        data_dir,
        host_stats,
        locks: Default::default(),
        listen_port: addr.port(),
    };

    deployments::spawn_poller(state.clone());

    let protected = Router::new()
        .nest("/system", system::router())
        .nest("/docker", docker::router())
        .nest("/stacks", stacks::router())
        .nest("/deployments", deployments::router())
        .nest("/ports", ports::router())
        .nest("/import", import::router())
        .nest("/updates", updates::router())
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_user));

    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .nest("/auth", auth::router())
        .nest("/webhooks", deployments::webhook_router().merge(stacks::webhook_router()))
        .merge(protected)
        .fallback(|| async { error::AppError::not_found("no such endpoint") });

    let app = Router::new()
        .nest("/api", api)
        .fallback(assets::serve)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!("Harbor listening on http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;
    Ok(())
}

/// Connects to the same engine the `docker` CLI uses (stacks shell out to
/// `docker compose`, so the two must agree): `DOCKER_HOST` if set, otherwise
/// the active docker context (e.g. Docker Desktop's socket on macOS).
fn connect_docker() -> anyhow::Result<bollard::Docker> {
    if std::env::var_os("DOCKER_HOST").is_none() {
        let endpoint = std::process::Command::new("docker")
            .args(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        if let Some(socket) = endpoint.as_deref().and_then(|e| e.strip_prefix("unix://")) {
            tracing::info!("using Docker socket {socket}");
            return Ok(bollard::Docker::connect_with_socket(
                socket,
                120,
                bollard::API_DEFAULT_VERSION,
            )?);
        }
    }
    Ok(bollard::Docker::connect_with_local_defaults()?)
}
