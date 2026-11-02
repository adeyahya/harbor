# Security policy

## Reporting a vulnerability

Please do not open a public GitHub issue for a security problem.

Email the maintainer (Ade Yahya) with a description, the version or commit you tested, and a way to reproduce the issue. You can find the address on the [GitHub profile](https://github.com/adeyahya). Allow a few days for a reply before disclosing it publicly.

## Supported versions

Harbor is a single-maintainer project. Security fixes go into `main`. There are no long-term release branches yet. If you run it, track `main` or the image tags published to GHCR.

## What to know before you expose Harbor

Harbor talks to the Docker Engine socket. On a typical install that socket is root-equivalent on the host: anyone who can use Harbor can start containers, mount host paths, and read other containers. Treat an account on Harbor like SSH access to the server.

- Put Harbor behind a TLS reverse proxy, or keep it on a private network or VPN. The container image listens on `0.0.0.0:9120` so the port mapping works; do not publish that port on the public internet without TLS and the proxy.
- The first visitor creates the admin account. Sessions are an httpOnly cookie. There is no multi-user permission model.
- Git tokens, webhook secrets, Google OAuth client secrets, refresh tokens, and rclone configs are stored in Harbor's SQLite database. The API does not return those secrets to the browser. Back up `harbor.db` as carefully as you would a password store, and do not commit it.
- GitHub webhooks are checked with the `X-Hub-Signature-256` HMAC. Container terminals reject WebSocket handshakes whose `Origin` is not Harbor's own host.
- This repository must not contain credentials, `.env` files, or database snapshots. `.gitignore` and `.dockerignore` exclude them. If one was committed, rotate the credential and remove it from history before treating the repository as public.
