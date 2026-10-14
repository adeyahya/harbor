//! Building deployments from git: cloning a branch, building its Dockerfile,
//! checking for new commits, and verifying GitHub webhook signatures.

use std::path::{Component, Path};

use anyhow::Context;
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use tokio::process::Command;

use crate::{process, updates::UpdateLog};

pub struct Commit {
    pub sha: String,
    pub message: String,
}

impl Commit {
    pub fn short(&self) -> &str {
        &self.sha[..self.sha.len().min(7)]
    }
}

/// Expands `owner/repo` shorthand to a GitHub URL; anything else is passed to
/// git as-is (https, ssh, file://).
pub fn normalize_url(input: &str) -> String {
    let s = input.trim();
    let is_shorthand = !s.contains("://")
        && !s.contains('@')
        && !s.starts_with('/')
        && s.split('/').count() == 2
        && s.split('/').all(|p| !p.is_empty());
    if is_shorthand {
        format!("https://github.com/{}.git", s.trim_end_matches(".git"))
    } else {
        s.to_string()
    }
}

/// `owner/repo` for GitHub URLs, otherwise the URL without credentials.
pub fn display_repo(url: &str) -> String {
    let s = url.trim_end_matches('/').trim_end_matches(".git");
    s.strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("git@github.com:"))
        .map(str::to_string)
        .unwrap_or_else(|| s.to_string())
}

/// A git command that never prompts for credentials (a missing token must
/// fail, not hang) and sends the access token as an HTTP header via env, so
/// it never appears in the URL, `.git/config`, `ps`, or git's error output.
fn git(token: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_ASKPASS", "true");
    if !token.is_empty() {
        let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
        cmd.env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.extraHeader")
            .env("GIT_CONFIG_VALUE_0", format!("Authorization: Basic {basic}"));
    }
    cmd
}

/// Shallow-clones `branch` into `dest` (replacing it) and returns its head commit.
pub async fn clone(log: &UpdateLog, url: &str, branch: &str, token: &str, dest: &Path) -> anyhow::Result<Commit> {
    if dest.exists() {
        tokio::fs::remove_dir_all(dest).await.context("clearing previous checkout")?;
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut cmd = git(token);
    cmd.args(["clone", "--depth", "1", "--single-branch", "--branch", branch, "--", url])
        .arg(dest);
    process::run(log, cmd, &format!("git clone --depth 1 --branch {branch} {}", display_repo(url))).await?;

    let mut rev = git(token);
    rev.args(["log", "-1", "--format=%H%n%s"]).current_dir(dest);
    let out = process::output(rev).await?;
    let (sha, message) = out.split_once('\n').unwrap_or((&out, ""));
    Ok(Commit {
        sha: sha.to_string(),
        message: message.to_string(),
    })
}

/// The current head commit of `branch` on the remote, without cloning.
pub async fn remote_head(url: &str, branch: &str, token: &str) -> anyhow::Result<Option<String>> {
    let mut cmd = git(token);
    cmd.args(["ls-remote", "--heads", "--", url, branch]);
    let out = process::output(cmd).await?;
    let want = format!("refs/heads/{branch}");
    Ok(out.lines().find_map(|line| {
        let (sha, name) = line.split_once('\t')?;
        (name == want).then(|| sha.to_string())
    }))
}

/// The remote's default branch (what `HEAD` points at).
pub async fn default_branch(url: &str, token: &str) -> anyhow::Result<String> {
    let mut cmd = git(token);
    cmd.args(["ls-remote", "--symref", "--", url, "HEAD"]);
    let out = process::output(cmd).await?;
    out.lines()
        .find_map(|l| l.strip_prefix("ref: refs/heads/")?.split_once('\t').map(|(b, _)| b.to_string()))
        .ok_or_else(|| anyhow::anyhow!("couldn't determine the repository's default branch"))
}

/// Rejects absolute paths and `..` so build paths stay inside the checkout.
pub fn validate_rel_path(path: &str, what: &str) -> Result<(), String> {
    let p = Path::new(path);
    if path.trim().is_empty() {
        return Err(format!("{what} is required"));
    }
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
        return Err(format!("{what} must be a relative path inside the repository"));
    }
    Ok(())
}

/// Builds the image with the Dockerfile at `<context>/<dockerfile>`, tagging
/// it with each of `tags`.
pub async fn build(
    log: &UpdateLog,
    checkout: &Path,
    context: &str,
    dockerfile: &str,
    build_args: &[String],
    tags: &[String],
) -> anyhow::Result<()> {
    validate_rel_path(context, "root directory").map_err(anyhow::Error::msg)?;
    validate_rel_path(dockerfile, "Dockerfile path").map_err(anyhow::Error::msg)?;
    let file = Path::new(context).join(dockerfile);
    if !checkout.join(&file).is_file() {
        anyhow::bail!("no Dockerfile at {} in the repository", file.display());
    }

    let mut cmd = Command::new("docker");
    cmd.arg("build").arg("-f").arg(&file);
    for tag in tags {
        cmd.args(["-t", tag]);
    }
    for arg in build_args {
        cmd.args(["--build-arg", arg]);
    }
    cmd.arg(context)
        .current_dir(checkout)
        .env("DOCKER_BUILDKIT", "1")
        .env("BUILDKIT_PROGRESS", "plain");
    let shown = format!(
        "docker build -f {} {}{}",
        file.display(),
        tags.iter().map(|t| format!("-t {t} ")).collect::<String>(),
        context
    );
    process::run(log, cmd, &shown).await
}

/// Checks GitHub's `X-Hub-Signature-256: sha256=<hex>` header against the
/// raw request body, in constant time.
pub fn verify_signature(secret: &str, body: &[u8], header: &str) -> bool {
    let Some(hex_sig) = header.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(sig) = hex::decode(hex_sig) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls() {
        assert_eq!(normalize_url("acme/api"), "https://github.com/acme/api.git");
        assert_eq!(normalize_url(" acme/api.git "), "https://github.com/acme/api.git");
        assert_eq!(normalize_url("https://gitlab.com/a/b.git"), "https://gitlab.com/a/b.git");
        assert_eq!(normalize_url("git@github.com:a/b.git"), "git@github.com:a/b.git");
        assert_eq!(normalize_url("file:///tmp/repo.git"), "file:///tmp/repo.git");
        assert_eq!(display_repo("https://github.com/acme/api.git"), "acme/api");
    }

    #[test]
    fn validates_paths() {
        assert!(validate_rel_path(".", "x").is_ok());
        assert!(validate_rel_path("apps/web", "x").is_ok());
        assert!(validate_rel_path("../etc", "x").is_err());
        assert!(validate_rel_path("a/../../b", "x").is_err());
        assert!(validate_rel_path("/etc", "x").is_err());
        assert!(validate_rel_path("", "x").is_err());
    }

    #[test]
    fn verifies_github_signatures() {
        // Example from GitHub's webhook documentation.
        let secret = "It's a Secret to Everybody";
        let body = b"Hello, World!";
        let sig = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
        assert!(verify_signature(secret, body, sig));
        assert!(!verify_signature(secret, b"Hello, World?", sig));
        assert!(!verify_signature("wrong", body, sig));
        assert!(!verify_signature(secret, body, "sha1=abc"));
    }
}
