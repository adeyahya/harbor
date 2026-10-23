//! Interactive shells in running containers, over a WebSocket.
//!
//! The browser sends keystrokes as binary frames and control messages
//! (`{"type":"resize","cols":80,"rows":24}`) as text frames; the server sends
//! the TTY's output as binary frames and `{"type":"exit"|"error",...}` as text.
//! Each session is recorded as an update (who opened which shell, and when it
//! ended, never what was typed) and can be ended from Activity like any other
//! running operation.

use std::time::Instant;

use axum::{
    Extension,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, header},
    response::Response,
};
use bollard::{
    exec::{ResizeExecOptions, StartExecOptions, StartExecResults},
    models::ExecConfig,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncWriteExt;

use crate::{
    auth::User,
    error::{AppError, AppResult},
    state::AppState,
    updates,
};

#[derive(Deserialize)]
pub struct TerminalQuery {
    /// `auto` (bash if the image has it, else sh) or a shell path.
    #[serde(default)]
    shell: String,
    /// User to run the shell as; empty means the container's default.
    #[serde(default)]
    user: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Control {
    Resize { cols: u16, rows: u16 },
    Input { data: String },
}

/// Shells offered in the UI; anything else is rejected so the query string
/// can't be used to run arbitrary commands through a link.
const SHELLS: &[&str] = &["/bin/bash", "/bin/sh", "/bin/ash", "/bin/zsh", "/bin/fish"];

fn shell_command(shell: &str) -> AppResult<Vec<String>> {
    match shell {
        "" | "auto" => Ok(vec![
            "/bin/sh".into(),
            "-c".into(),
            "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi".into(),
        ]),
        s if SHELLS.contains(&s) => Ok(vec![s.into()]),
        _ => Err(AppError::bad_request(format!("unsupported shell '{shell}'"))),
    }
}

/// Browsers send cookies with cross-site WebSocket handshakes from the same
/// site, so check the Origin like a CSRF token: a shell is root on the host.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) else {
        // Non-browser clients don't send one and can't ride a session cookie.
        return true;
    };
    let origin_host = origin.split_once("://").map(|(_, h)| h).unwrap_or(origin);
    let host_of = |name: &str| headers.get(name).and_then(|h| h.to_str().ok()).map(|h| h.split(',').next().unwrap_or("").trim().to_string());
    [host_of("x-forwarded-host"), host_of(header::HOST.as_str())]
        .into_iter()
        .flatten()
        .any(|h| h.eq_ignore_ascii_case(origin_host))
}

pub async fn open(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
    Query(q): Query<TerminalQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    if !same_origin(&headers) {
        return Err(AppError::new(axum::http::StatusCode::FORBIDDEN, "cross-origin terminal requests are not allowed"));
    }
    let cmd = shell_command(q.shell.trim())?;
    let exec_user = q.user.trim().to_string();
    if exec_user.chars().any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '.'))) {
        return Err(AppError::bad_request("user must be a name or uid[:gid]"));
    }
    let container = state.docker.inspect_container(&id, None).await?;
    let name = container.name.as_deref().unwrap_or(&id).trim_start_matches('/').to_string();
    let running = container.state.as_ref().and_then(|s| s.running).unwrap_or(false);
    let size = (q.cols.unwrap_or(80).clamp(10, 500), q.rows.unwrap_or(24).clamp(5, 300));

    Ok(ws.on_upgrade(move |mut socket| async move {
        if !running {
            send_json(&mut socket, json!({ "type": "error", "message": format!("{name} isn't running; start it to open a terminal") })).await;
            return;
        }
        let shown = if q.shell.is_empty() { "auto".to_string() } else { q.shell.clone() };
        let docker = state.docker.clone();
        let result = updates::spawn(&state, &user, "container", &name, "terminal", move |log| async move {
            let who = if exec_user.is_empty() { "the default user".to_string() } else { exec_user.clone() };
            log.set_detail(&format!("{shown} as {who}")).await;
            log.line(format!("opened a shell ({shown}) as {who}")).await;
            let started = Instant::now();
            let outcome = session(&docker, &id, cmd, exec_user, size, &mut socket).await;
            let elapsed = started.elapsed().as_secs();
            let took = format!("{}m {}s", elapsed / 60, elapsed % 60);
            match outcome {
                Ok(Some(code)) => log.line(format!("shell exited with code {code} after {took}")).await,
                Ok(None) => log.line(format!("terminal closed after {took}")).await,
                Err(e) => {
                    send_json(&mut socket, json!({ "type": "error", "message": format!("{e:#}") })).await;
                    return Err(e);
                }
            }
            let _ = socket.send(Message::Close(None)).await;
            Ok(())
        })
        .await;
        if let Err(e) = result {
            tracing::warn!("couldn't start terminal session: {}", e.message);
        }
    }))
}

async fn send_json(socket: &mut WebSocket, value: serde_json::Value) {
    let _ = socket.send(Message::Text(value.to_string().into())).await;
}

/// Runs the shell until it exits (returning its exit code) or the browser
/// disconnects (returning `None`).
async fn session(
    docker: &bollard::Docker,
    container: &str,
    cmd: Vec<String>,
    user: String,
    (cols, rows): (u16, u16),
    socket: &mut WebSocket,
) -> anyhow::Result<Option<i64>> {
    let exec = docker
        .create_exec(
            container,
            ExecConfig {
                cmd: Some(cmd),
                user: (!user.is_empty()).then_some(user),
                env: Some(vec!["TERM=xterm-256color".into()]),
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                tty: Some(true),
                ..Default::default()
            },
        )
        .await?;
    let StartExecResults::Attached { mut output, mut input } =
        docker.start_exec(&exec.id, Some(StartExecOptions { tty: true, ..Default::default() })).await?
    else {
        anyhow::bail!("the shell didn't attach");
    };
    // The exec only accepts a size once it's running.
    let _ = docker.resize_exec(&exec.id, ResizeExecOptions { width: cols, height: rows }).await;

    loop {
        tokio::select! {
            chunk = output.next() => match chunk {
                Some(Ok(out)) => {
                    if socket.send(Message::Binary(out.into_bytes())).await.is_err() {
                        return Ok(None);
                    }
                }
                Some(Err(e)) => return Err(e.into()),
                None => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Binary(data))) => input.write_all(&data).await?,
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<Control>(&text) {
                    Ok(Control::Resize { cols, rows }) => {
                        let _ = docker
                            .resize_exec(&exec.id, ResizeExecOptions { width: cols.clamp(10, 500), height: rows.clamp(5, 300) })
                            .await;
                    }
                    Ok(Control::Input { data }) => input.write_all(data.as_bytes()).await?,
                    Err(_) => {}
                },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Ok(None),
                Some(Ok(_)) => {}
            },
        }
    }
    let code = docker.inspect_exec(&exec.id).await.ok().and_then(|e| e.exit_code).unwrap_or(0);
    send_json(socket, json!({ "type": "exit", "code": code })).await;
    Ok(Some(code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_static(v));
        }
        h
    }

    #[test]
    fn checks_origin_against_host() {
        assert!(same_origin(&headers(&[("host", "harbor.example.com")])));
        assert!(same_origin(&headers(&[("host", "10.0.0.2:9120"), ("origin", "http://10.0.0.2:9120")])));
        assert!(!same_origin(&headers(&[("host", "10.0.0.2:9120"), ("origin", "http://evil.example.com")])));
        assert!(same_origin(&headers(&[
            ("host", "127.0.0.1:9120"),
            ("x-forwarded-host", "harbor.example.com"),
            ("origin", "https://harbor.example.com"),
        ])));
    }

    #[test]
    fn only_known_shells() {
        assert_eq!(shell_command("/bin/bash").unwrap(), vec!["/bin/bash"]);
        assert_eq!(shell_command("auto").unwrap()[0], "/bin/sh");
        assert!(shell_command("/bin/sh -c 'rm -rf /'").is_err());
    }
}
