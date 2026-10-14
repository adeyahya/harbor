//! Runs external commands (docker compose, git, docker build) with their
//! output streamed into an update log.

use std::process::Stdio;

use anyhow::Context;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::Command,
};

use crate::updates::UpdateLog;

/// Runs `cmd`, streaming stdout and stderr line by line into `log`. `shown`
/// is the command line echoed into the log (keep secrets out of it).
pub async fn run(log: &UpdateLog, mut cmd: Command, shown: &str) -> anyhow::Result<()> {
    log.line(format!("$ {shown}")).await;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let program = cmd.as_std().get_program().to_string_lossy().into_owned();
    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to run `{program}`; is it installed?"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    tokio::join!(pump(stdout, log), pump(stderr, log));
    let status = child.wait().await?;
    if !status.success() {
        anyhow::bail!("`{program}` exited with {status}");
    }
    Ok(())
}

/// Runs `cmd` and returns its trimmed stdout, failing with its stderr.
pub async fn output(mut cmd: Command) -> anyhow::Result<String> {
    let program = cmd.as_std().get_program().to_string_lossy().into_owned();
    let out = cmd
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .with_context(|| format!("failed to run `{program}`; is it installed?"))?;
    if !out.status.success() {
        anyhow::bail!(
            "`{program}` failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn pump(reader: impl AsyncRead + Unpin, log: &UpdateLog) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log.line(strip_ansi(&line)).await;
    }
}

/// Removes terminal escape sequences (colors, cursor moves) that some tools
/// emit even when not attached to a terminal.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            // CSI: parameters until a final byte in @..~
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        } else {
            chars.next();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn strips_ansi() {
        assert_eq!(super::strip_ansi("\u{1b}[33m1 warning\u{1b}[0m found"), "1 warning found");
        assert_eq!(super::strip_ansi("plain"), "plain");
    }
}
