# Contributing to Harbor

Thanks for looking at Harbor. Issues and pull requests are welcome.

## Development setup

You need Rust 1.98 (the repo pins this in `rust-toolchain.toml`), Node.js 22, pnpm 11, and a Docker engine with the Compose plugin if you want to exercise deploys.

```bash
cd frontend && pnpm install && pnpm dev
```

```bash
cd backend && cargo run
```

Vite serves the UI at http://localhost:5173 and proxies `/api` to the backend on http://127.0.0.1:9120. The first visit creates the admin account.

To run the same image CI builds:

```bash
docker compose up -d --build
```

## Checks

CI runs these. Please run them before opening a pull request.

Backend, from `backend/`:

```bash
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
```

Frontend, from `frontend/`:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`cargo test` includes unit tests that do not need Docker. A few tests are marked `#[ignore]` because they talk to a real engine; run those with `cargo test -- --ignored` when you have Docker.

## Pull requests

- Open a pull request against `main`. Do not push to `main` directly.
- Describe what changed and how you tested it. The pull request template is a good checklist.
- Keep changes focused. A formatting-only pass belongs in its own commit.
- Do not commit secrets, `.env` files, database files, or data from a real Harbor install. See [SECURITY.md](SECURITY.md).

## Project layout

The [README](README.md#layout) maps the backend modules and the frontend. The React app is compiled into the Rust binary, so a release build needs `pnpm build` in `frontend/` first (the Dockerfile does this for you).
