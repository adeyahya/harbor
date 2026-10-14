# Harbor

A self-hosted dashboard for deploying and managing Docker workloads on a single
server, inspired by [Komodo](https://komo.do). The backend is Rust (axum + SQLite
+ the Docker API), and the frontend is React + shadcn/ui with a Railway-inspired
design, compiled into the backend binary.

## Features

- **Canvas**: every stack and deployment as a card with live status, services
  and published ports, plus host CPU/memory/disk. Clicking a card opens its
  panel with Deployments, Logs, Variables and Settings tabs. Press ⌘K to search.
  Pin important services to the top and put the rest in named, collapsible
  groups (⋯ on a card); the layout is stored on the server.
- **Stacks**: Docker Compose projects. The compose file is either edited in the
  UI or comes from a **git repository** (with auto-deploy on push, like
  deployments). Variables are written to a `.env` file; deploy, pull, restart,
  stop or take them down. Stacks can run from a chosen project directory so
  relative paths in the compose file keep working.
- **Deployments**: single containers with ports, volumes, environment,
  network, restart policy and command. The image comes from either:
  - a **registry image**, pulled on each deploy, or
  - a **git repository** (GitHub `owner/repo` or any git URL): Harbor
    shallow-clones the branch, builds its Dockerfile into
    `harbor/<name>:<commit>`, and recreates the container. Optional root
    directory, Dockerfile path, build args, and an access token for private
    repos. With **auto-deploy** on, new commits are deployed automatically.

  The port editor flags host ports already taken (by a container, Harbor, or
  another process), suggests free ones, and offers the ports the image
  `EXPOSE`s.
- **Rollback**: every successful deploy records the exact image it ran (the
  built `harbor/<name>:<commit>` tag, or the pulled image's ID) and the
  settings it ran with. Rolling back reruns that image with those settings, with
  no rebuild or pull. Stacks roll back their compose file and variables.
- **Containers**: list, start/stop/restart/remove, live log streaming, inspect.
- **Images, volumes, networks**: list, remove, prune. Click a volume to browse its
  files read-only: folders, text previews, image previews and downloads. Harbor
  reads volumes through a small `alpine` helper container (pulled on first use,
  removed after 10 minutes idle, hidden from Harbor's lists), so it works
  even when volume data lives in a VM, as with Docker Desktop.
- **Git accounts** (Settings): credentials stored once and used by every
  git-backed service. Services use the account for their repository's host
  automatically, or a specific one, or none.
- **Import existing containers** (e.g. from Komodo): compose projects become
  stacks and standalone containers become deployments, without restarting
  anything. See [Moving from Komodo](#moving-from-komodo).
- **Activity**: every action is recorded with its status and full output, and
  streamed live while it runs.
- **Auth**: the first visit creates an admin account. Sessions use an httpOnly cookie.

Not yet implemented (Komodo has them): multiple servers, git-backed stacks,
procedures/actions, GitOps resource sync, alerting.

## Requirements

To run Harbor in Docker you only need Docker itself (see
[Running Harbor in Docker](#running-harbor-in-docker)). To build and run it
directly on the host:

- Rust (stable), Node 20+ and pnpm
- Docker with the Compose plugin (`docker compose`), and `git`

Harbor connects to the same engine as your `docker` CLI: `DOCKER_HOST` if set,
otherwise the active `docker context` (for example Docker Desktop on macOS).

## Running

Build the frontend once, then run the backend, which serves it:

```bash
cd frontend && pnpm install && pnpm build
cd ../backend && cargo run --release
```

Open http://127.0.0.1:9120 and create your admin account.

## Running Harbor in Docker

The repository ships a multi-stage `Dockerfile` (it builds the UI and the Rust
binary, then copies them into a slim Debian image with `git` and the Docker CLI,
Compose and Buildx) and a `compose.yaml` that runs it.

```bash
git clone <this repo> harbor && cd harbor
sudo mkdir -p /var/lib/harbor
docker compose up -d --build
```

Then open `http://<server>:9120` and create the admin account. Edit `hostname:`
in `compose.yaml` first if you want the dashboard to show your server's name.

### How it works and what it needs

- **The Docker socket.** Harbor drives the *host's* Docker engine through
  `/var/run/docker.sock`. Without that mount Harbor exits at startup with
  `Socket not found: /var/run/docker.sock`. If your socket lives elsewhere
  (rootless Docker, Podman), mount it and set `DOCKER_HOST=unix:///path/to/socket`.
- **The data directory at the same path on both sides.** Stacks run with
  `docker compose` inside Harbor's container, but the host's Docker resolves
  bind-mount paths, and it resolves them **on the host**. A stack's
  `./config:/config` becomes `<data dir>/stacks/<name>/config`, so that path has
  to mean the same thing on the host and in the container:

  ```yaml
  volumes:
    - /var/lib/harbor:/var/lib/harbor   # same path both sides
  environment:
    HARBOR_DATA_DIR: /var/lib/harbor
  ```

  To use another location, change all three to the same path. Don't use a named
  volume here: Harbor would start, but relative bind mounts in stacks would
  point at empty directories on the host.
- **Runs as root.** Access to the Docker socket is root-equivalent on the host
  anyway, so there's no meaningful privilege drop to make. Treat Harbor like
  SSH access to the server: put it behind a reverse proxy with TLS, or keep it
  on a private network or VPN.
- **Harbor sees itself.** Its own container appears in the Containers list.
  Stopping or removing it from the UI stops Harbor (`unless-stopped` won't bring
  it back after a manual stop); start it again with `docker compose up -d`.

### Host networking (Linux)

With the default port mapping Harbor can only check Docker-published ports when
it suggests free host ports; other processes on the host are invisible from the
container's network. The host stats on the canvas are also the container's view
(e.g. disk usage of the filesystem it sees). On a Linux server you can run with
host networking for accurate port checks, and to bind to localhost behind a
reverse proxy:

```yaml
services:
  harbor:
    network_mode: host        # replaces "ports:"
    environment:
      HARBOR_ADDR: 127.0.0.1:9120   # or 0.0.0.0:9120 to expose directly
```

Docker Desktop (macOS/Windows) handles host networking differently; keep the
port mapping there.

### Reverse proxy and webhooks

Any reverse proxy works. Live logs stream over server-sent events, so turn off
response buffering for Harbor. For example, with Caddy:

```
harbor.example.com {
    reverse_proxy 127.0.0.1:9120 {
        flush_interval -1
    }
}
```

GitHub webhooks then use `https://harbor.example.com/api/webhooks/github/<service>`.

### Upgrading and backups

```bash
git pull && docker compose up -d --build
```

Database migrations run automatically at startup. Everything Harbor stores is
in the data directory: back up `harbor.db` (stop Harbor first, or use
`sqlite3 harbor.db ".backup backup.db"`) and the `stacks/` folder. Volumes and
images used by your services live in Docker as usual.

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
| `HARBOR_ADDR`     | `127.0.0.1:9120` | Listen address. Use `0.0.0.0:9120` to expose (the Docker image does). |
| `HARBOR_DATA_DIR` | `./data`         | SQLite database and stack files (`/var/lib/harbor` in the Docker image). |
| `DOCKER_HOST`     | active context   | Docker engine to manage (`unix:///var/run/docker.sock` in the Docker image). |
| `HARBOR_GIT_POLL_SECS` | `60`        | How often auto-deploy checks branches for new commits. `0` disables polling. |
| `HARBOR_HELPER_IDLE_SECS` | `600`    | How long an idle volume-browser helper container is kept. |
| `RUST_LOG`        | `harbor=info`    | Log filter.                                  |

## Moving from Komodo

Harbor can take over containers that Komodo (or anything else) started on the
same Docker engine. Open **Import** (the banner on the canvas, *Create → Import
existing containers*, or ⌘K):

- **Komodo stacks** (compose projects) import as stacks. Harbor reads the
  compose file and `.env` from the project's directory and keeps running the
  stack from that directory, so relative paths behave as before. If the
  directory is a git checkout (Komodo's git-backed stacks), Harbor offers to use
  the repository: deploys then fetch the branch into that checkout and reset to
  it. Local edits to tracked files are discarded; untracked files such as data
  folders are kept.
- **Komodo deployments** (single containers) import as deployments. Harbor
  derives image, ports, volumes, variables (without the image's defaults),
  labels, network and restart policy from the running container, and lists
  anything it can't carry over yet (capabilities, devices, resource limits,
  custom entrypoint, …) before you confirm. Afterwards you can switch the
  source to a GitHub repository in Settings.

Importing never restarts anything. The containers keep running until you
deploy from Harbor, which recreates them with Harbor's settings (an imported
deployment is renamed to its Harbor name at that point). Komodo's own
containers are flagged and not counted.

Before importing, **stop Komodo from managing those services** (remove them from
Komodo, or stop Komodo's Periphery agent), otherwise both tools will redeploy
them. Your data in named volumes is untouched by either.

If Harbor runs in Docker, mount Komodo's directory at the same path so Harbor
can read the compose files and run the stacks from there:

```yaml
volumes:
  - /etc/komodo:/etc/komodo
```

## Deploying from GitHub

1. **Create → GitHub repo**, enter `owner/repo` (leave the branch empty to use
   the default branch), then set ports and variables in the service's Settings.
2. **Private repos:** add a GitHub account under **Settings → Git accounts**
   with a [fine-grained token](https://github.com/settings/personal-access-tokens)
   that has read-only *Contents* access. Every service whose repository is on
   that host uses it automatically; pick a different account (or none) in a
   service's Settings. Tokens are stored in Harbor's database and never sent
   back to the browser.
3. **Deploy on push:** turn on *Auto-deploy*. Harbor polls the branch (see
   `HARBOR_GIT_POLL_SECS`), which works even when GitHub can't reach your server.
   For instant deploys, add a GitHub webhook pointing at
   `https://<harbor-host>/api/webhooks/github/<service-name>`, with content type
   `application/json`, the secret shown in Settings, and just the push event.
   Requests are verified with the `X-Hub-Signature-256` HMAC.

Each build is kept as `harbor/<name>:<commit>` so it can be rolled back to.
Builds are labelled `harbor.deployment` and **"Prune unused" on the Images page
skips them**; remove old builds individually there when you need the space.
Rolling back after the target image has been removed fails with a clear error
and leaves the running container alone. A rollback doesn't change what
auto-deploy considers "seen", so it won't immediately redeploy the newer
commit, but the next push deploys as usual.

Harbor controls your Docker engine, which is root-equivalent on the host. Only
expose it on a trusted network or behind a TLS reverse proxy.

## Layout

```
Dockerfile         multi-stage image build (UI + binary + docker CLI and git)
compose.yaml       runs Harbor itself in Docker
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
    ports.rs       host port availability and suggestions
    import.rs      discovering and importing containers Harbor didn't create
    canvas.rs      canvas groups and pinning
    accounts.rs    git accounts and token resolution
    volume_browser.rs  read-only volume file browser (helper container)
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
