use std::{sync::Arc, time::Duration};

use axum::{Json, Router, extract::State, routing::get};
use serde::Serialize;
use sysinfo::{Disks, System};
use tokio::sync::RwLock;

use crate::{error::AppResult, state::AppState};

#[derive(Clone, Default, Serialize)]
pub struct HostStats {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub cpu_count: usize,
    pub cpu_percent: f32,
    pub mem_total: u64,
    pub mem_used: u64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub load_average: [f64; 3],
    pub uptime: u64,
}

/// CPU usage needs two samples over time, so stats are refreshed by a
/// background task and requests read the latest snapshot.
pub fn spawn_collector(stats: Arc<RwLock<HostStats>>) {
    tokio::spawn(async move {
        let mut sys = System::new_all();
        let mut disks = Disks::new_with_refreshed_list();
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            disks.refresh(true);

            // Count each physical device once; macOS exposes several APFS
            // volumes that share a container.
            let mut seen = std::collections::HashSet::new();
            let (disk_total, disk_avail) = disks
                .iter()
                .filter(|d| seen.insert(d.name().to_os_string()))
                .fold((0, 0), |(t, a), d| (t + d.total_space(), a + d.available_space()));
            let load = System::load_average();

            *stats.write().await = HostStats {
                hostname: System::host_name().unwrap_or_default(),
                os: System::long_os_version().unwrap_or_default(),
                kernel: System::kernel_version().unwrap_or_default(),
                cpu_count: sys.cpus().len(),
                cpu_percent: sys.global_cpu_usage(),
                mem_total: sys.total_memory(),
                mem_used: sys.used_memory(),
                disk_total,
                disk_used: disk_total.saturating_sub(disk_avail),
                load_average: [load.one, load.five, load.fifteen],
                uptime: System::uptime(),
            };
        }
    });
}

#[derive(Serialize)]
struct DockerSummary {
    version: String,
    api_version: String,
    containers: i64,
    containers_running: i64,
    containers_stopped: i64,
    images: i64,
}

#[derive(Serialize)]
struct SystemOverview {
    host: HostStats,
    docker: Option<DockerSummary>,
    docker_error: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(overview))
}

async fn overview(State(state): State<AppState>) -> AppResult<Json<SystemOverview>> {
    let host = state.host_stats.read().await.clone();
    let docker = async {
        let info = state.docker.info().await?;
        let version = state.docker.version().await?;
        Ok::<_, bollard::errors::Error>(DockerSummary {
            version: version.version.unwrap_or_default(),
            api_version: version.api_version.unwrap_or_default(),
            containers: info.containers.unwrap_or_default(),
            containers_running: info.containers_running.unwrap_or_default(),
            containers_stopped: info.containers_stopped.unwrap_or_default(),
            images: info.images.unwrap_or_default(),
        })
    }
    .await;
    let (docker, docker_error) = match docker {
        Ok(d) => (Some(d), None),
        Err(e) => (None, Some(e.to_string())),
    };
    Ok(Json(SystemOverview {
        host,
        docker,
        docker_error,
    }))
}
