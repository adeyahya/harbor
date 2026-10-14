# Harbor

A self-hosted dashboard for deploying and managing Docker workloads on a single
server, inspired by [Komodo](https://komo.do). The backend is Rust (axum + SQLite
+ the Docker API), and the frontend is React + shadcn/ui with a Railway-inspired
design, compiled into the backend binary.

## Features

- **Canvas**: every stack and deployment as a card with live status, services
  and published ports, plus host CPU/memory/disk. Clicking a card opens its
  panel with Deployments, Logs, Variables and Settings tabs. Press ⌘K to search.
- **Stacks**: Docker Compose projects. Edit `compose.yaml` and `.env` in the UI, then
  deploy, pull, restart, stop or take them down. Files are written to
  `data/stacks/<name>/` and run with `docker compose`.
- **Deployments**: single containers with ports, volumes, environment,
  network, restart policy and command. The image comes from either:
  - a **registry image**, pulled on each deploy, or
  - a **git repository** (GitHub `owner/repo` or any git URL): Harbor
    shallow-clones the branch, builds its Dockerfile into
    `harbor/<name>:<commit>`, and recreates the container. Optional root
    directory, Dockerfile path, build args, and an access token for private
    repos. With **auto-deploy** on, new commits are deployed automatically.
- **Containers**: list, start/stop/restart/remove, live log streaming, inspect.
- **Images, volumes, networks**: list, remove, prune.
- **Activity**: every action is recorded with its status and full output, and
  streamed live while it runs.
- **Auth**: the first visit creates an admin account. Sessions use an httpOnly cookie.

Not yet implemented (Komodo has them): multiple servers, git-backed stacks,
rollbacks, procedures/actions, GitOps resource sync, alerting.

## Requirements

- Rust (stable), Node 20+ and pnpm
- Docker with the Compose plugin (`docker compose`)

Harbor connects to the same engine as your `docker` CLI: `DOCKER_HOST` if set,
otherwise the active `docker context` (for example Docker Desktop on macOS).

## Running

Build the frontend once, then run the backend, which serves it:

```bash
cd frontend && pnpm install && pnpm build
cd ../backend && cargo run --release
```

Open http://127.0.0.1:9120 and create your admin account.

## Development

Run the backend and the Vite dev server in two terminals. Vite proxies `/api` to
the backend and hot-reloads the UI:

```bash
cd backend && cargo run
```

```bash
cd frontend && pnpm dev
```

Then open http://localhost:5173.

## Configuration

| Variable          | Default          | Description                                  |
| ----------------- | ---------------- | -------------------------------------------- |
| `HARBOR_ADDR`     | `127.0.0.1:9120` | Listen address. Use `0.0.0.0:9120` to expose. |
| `HARBOR_DATA_DIR` | `./data`         | SQLite database and stack files.             |
| `HARBOR_GIT_POLL_SECS` | `60`        | How often auto-deploy checks branches for new commits. `0` disables polling. |
| `RUST_LOG`        | `harbor=info`    | Log filter.                                  |

## Deploying from GitHub

1. **Create → GitHub repo**, enter `owner/repo` (leave the branch empty to use
   the default branch), then set ports and variables in the service's Settings.
2. **Private repos:** add a [fine-grained token](https://github.com/settings/personal-access-tokens)
   with read-only *Contents* access in Settings → Source → Access token. It's
   stored in Harbor's database and never sent back to the browser.
3. **Deploy on push:** turn on *Auto-deploy*. Harbor polls the branch (see
   `HARBOR_GIT_POLL_SECS`), which works even when GitHub can't reach your server.
   For instant deploys, add a GitHub webhook pointing at
   `https://<harbor-host>/api/webhooks/github/<service-name>`, with content type
   `application/json`, the secret shown in Settings, and just the push event.
   Requests are verified with the `X-Hub-Signature-256` HMAC.

Each build is kept as `harbor/<name>:<commit>`, which uses disk space over time;
prune unused images from the Images page.

Harbor controls your Docker engine, which is root-equivalent on the host. Only
expose it on a trusted network or behind a TLS reverse proxy.

## Layout

```
backend/
  migrations/      SQLite schema (applied on startup)
  src/
    main.rs        startup, routing, Docker connection
    auth.rs        setup/login/logout, session middleware
    updates.rs     action records + background task runner
    stacks.rs      compose stacks
    deployments.rs single-container deployments, GitHub webhook, auto-deploy poller
    git.rs         clone, docker build, remote head lookup, webhook signatures
    process.rs     runs git/docker commands with output streamed to updates
    docker.rs      containers, logs (SSE), images, volumes, networks
    system.rs      host stats collector
    assets.rs      embedded frontend
frontend/
  src/
    api.ts         API client and types
    components/ui/ shadcn/ui primitives (generated; edit sparingly)
    components/app/ app components: layout, service panel, log viewer,
                   variables editor, command menu, action tray
    pages/         canvas, service panels, Docker resource pages
```
