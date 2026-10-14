use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use bollard::Docker;
use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::system::HostStats;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub docker: Docker,
    pub data_dir: PathBuf,
    pub host_stats: Arc<RwLock<HostStats>>,
    /// Harbor's own port, never suggested for port mappings.
    pub listen_port: u16,
    /// Volume browser helper containers.
    pub helpers: crate::volume_browser::Helpers,
    /// One lock per resource so overlapping operations (e.g. two quick pushes)
    /// run one after another instead of racing.
    pub locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

impl AppState {
    pub fn stacks_dir(&self) -> PathBuf {
        self.data_dir.join("stacks")
    }

    pub fn builds_dir(&self) -> PathBuf {
        self.data_dir.join("builds")
    }

    pub fn lock_for(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks
            .lock()
            .expect("locks poisoned")
            .entry(key.to_string())
            .or_default()
            .clone()
    }
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Names become compose project names and container names, so keep them to a
/// conservative character set that is valid for both.
pub fn validate_name(name: &str) -> Result<(), crate::error::AppError> {
    let valid = !name.is_empty()
        && name.len() <= 63
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(crate::error::AppError::bad_request(
            "name must be 1-63 chars of lowercase letters, digits, '-' or '_', starting with a letter or digit",
        ))
    }
}
