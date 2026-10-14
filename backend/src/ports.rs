//! Host port availability for the port-mapping editor: which ports are taken
//! (and by what), and suggestions for free ones.

use std::{
    collections::{HashMap, HashSet},
    net::{Ipv4Addr, TcpListener, UdpSocket},
};

use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use bollard::{models::PortSummaryTypeEnum, query_parameters::ListContainersOptions};
use serde::{Deserialize, Serialize};

use crate::{error::AppResult, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(ports))
}

#[derive(Deserialize)]
struct PortsQuery {
    /// Comma-separated `port[/proto]` entries to check.
    check: Option<String>,
    /// How many free ports to suggest.
    suggest: Option<usize>,
    /// Where to start looking for suggestions.
    near: Option<u16>,
    /// Comma-separated ports never to suggest (e.g. ones already in the form).
    exclude: Option<String>,
    /// `deployment:<name>` or `stack:<name>`: ports held by this resource's
    /// own containers don't count as taken.
    owner: Option<String>,
}

#[derive(Serialize)]
struct PortStatus {
    port: u16,
    protocol: String,
    available: bool,
    /// Container name, "Harbor", or "another process" (best effort).
    used_by: Option<String>,
}

#[derive(Serialize)]
struct PortsResponse {
    checked: Vec<PortStatus>,
    suggestions: Vec<u16>,
}

/// Ports published by running containers: (port, proto) -> (container, owned).
async fn published(state: &AppState, owner: Option<&str>) -> HashMap<(u16, String), (String, bool)> {
    let (owner_label, owner_value) = match owner.and_then(|o| o.split_once(':')) {
        Some(("deployment", name)) => ("harbor.deployment", name),
        Some(("stack", name)) => ("com.docker.compose.project", name),
        _ => ("", ""),
    };
    // A deployment also owns a container named after it, or one it adopted on
    // import (neither carries Harbor's label yet).
    let mut owner_names: Vec<String> = Vec::new();
    if owner_label == "harbor.deployment" {
        owner_names.push(owner_value.to_string());
        if let Ok(Some(adopted)) = sqlx::query_scalar::<_, String>("SELECT adopted_container FROM deployments WHERE name = ?")
            .bind(owner_value)
            .fetch_optional(&state.db)
            .await
            && !adopted.is_empty()
        {
            owner_names.push(adopted);
        }
    }
    let containers = state
        .docker
        .list_containers(Some(ListContainersOptions::default()))
        .await
        .unwrap_or_default();
    let mut map = HashMap::new();
    for c in containers {
        let name = c
            .names
            .as_ref()
            .and_then(|n| n.first())
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default();
        let owned = (!owner_label.is_empty()
            && c.labels.as_ref().and_then(|l| l.get(owner_label)).is_some_and(|v| v == owner_value))
            || owner_names.contains(&name);
        for p in c.ports.unwrap_or_default() {
            if let Some(public) = p.public_port {
                let proto = match p.typ {
                    Some(PortSummaryTypeEnum::UDP) => "udp",
                    Some(PortSummaryTypeEnum::SCTP) => "sctp",
                    _ => "tcp",
                };
                map.insert((public, proto.to_string()), (name.clone(), owned));
            }
        }
    }
    map
}

/// Whether something outside Docker's view already listens on the port. A
/// bind probe is best effort: it can't see every case, and it describes the
/// wrong machine if Harbor itself runs in a container.
fn bind_free(port: u16, proto: &str) -> bool {
    match proto {
        "udp" => UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok(),
        _ => TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok(),
    }
}

fn parse_entry(s: &str) -> Option<(u16, String)> {
    let (port, proto) = s.trim().split_once('/').unwrap_or((s.trim(), "tcp"));
    Some((port.parse().ok()?, proto.to_lowercase()))
}

async fn ports(State(state): State<AppState>, Query(q): Query<PortsQuery>) -> AppResult<Json<PortsResponse>> {
    let used = published(&state, q.owner.as_deref()).await;
    let harbor_port = state.listen_port;

    let status = |port: u16, proto: &str| -> PortStatus {
        let protocol = proto.to_string();
        if port == harbor_port && proto == "tcp" {
            return PortStatus { port, protocol, available: false, used_by: Some("Harbor".into()) };
        }
        match used.get(&(port, protocol.clone())) {
            // The resource's own container holds it; redeploying frees it.
            Some((_, true)) => PortStatus { port, protocol, available: true, used_by: None },
            Some((name, false)) => PortStatus { port, protocol, available: false, used_by: Some(name.clone()) },
            None if bind_free(port, proto) => PortStatus { port, protocol, available: true, used_by: None },
            None => PortStatus { port, protocol, available: false, used_by: Some("another process".into()) },
        }
    };

    let checked = q
        .check
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .filter_map(parse_entry)
        .map(|(port, proto)| status(port, &proto))
        .collect();

    let exclude: HashSet<u16> = q
        .exclude
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let mut suggestions = Vec::new();
    let want = q.suggest.unwrap_or(0).min(20);
    // Unprivileged ports only: binding below 1024 needs root on Linux.
    let mut port = q.near.filter(|&p| p >= 1024).unwrap_or(8000);
    let mut tries = 0;
    while suggestions.len() < want && tries < 5000 && port < u16::MAX {
        if !exclude.contains(&port) && status(port, "tcp").available && !used.contains_key(&(port, "tcp".into())) {
            suggestions.push(port);
        }
        port += 1;
        tries += 1;
    }

    Ok(Json(PortsResponse { checked, suggestions }))
}
