# syntax=docker/dockerfile:1

# ---- Frontend: build the React app -------------------------------------------
FROM node:22-bookworm-slim AS frontend
WORKDIR /src/frontend
RUN npm install -g pnpm@11.10.0
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# ---- Backend: build the Rust binary with the frontend embedded ---------------
FROM rust:1.98-bookworm AS backend
WORKDIR /src/backend
COPY backend/ ./
# build.rs, rust-embed and sqlx::migrate! read these at compile time.
COPY --from=frontend /src/frontend/dist /src/frontend/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/backend/target \
    cargo build --release --locked \
    && cp target/release/harbor /usr/local/bin/harbor

# ---- Docker CLI, Compose and Buildx (static binaries) ------------------------
FROM docker:29-cli AS docker-cli

# ---- Runtime -----------------------------------------------------------------
FROM debian:bookworm-slim
# Harbor shells out to git (repo builds) and the docker CLI (compose, build).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
COPY --from=backend /usr/local/bin/harbor /usr/local/bin/harbor

# Listen on all interfaces inside the container, talk to the host's Docker
# through the mounted socket, and keep state in the data directory.
#
# No VOLUME on purpose: the data directory must be bind-mounted at the *same*
# path on the host (see README), and an implicit anonymous volume would hide a
# missing bind and break relative bind mounts in stacks.
ENV HARBOR_ADDR=0.0.0.0:9120 \
    HARBOR_DATA_DIR=/var/lib/harbor \
    DOCKER_HOST=unix:///var/run/docker.sock

EXPOSE 9120
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:9120/api/health || exit 1
CMD ["harbor"]
