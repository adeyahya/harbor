CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);

CREATE TABLE stacks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    compose    TEXT NOT NULL DEFAULT '',
    env        TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE deployments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    image      TEXT NOT NULL,
    ports      TEXT NOT NULL DEFAULT '',
    env        TEXT NOT NULL DEFAULT '',
    volumes    TEXT NOT NULL DEFAULT '',
    network    TEXT NOT NULL DEFAULT '',
    restart    TEXT NOT NULL DEFAULT 'unless-stopped',
    command    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE updates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    operation   TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_name TEXT NOT NULL,
    status      TEXT NOT NULL,
    log         TEXT NOT NULL DEFAULT '',
    username    TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT
);

CREATE INDEX updates_started_at ON updates(started_at DESC);
CREATE INDEX updates_target ON updates(target_type, target_name);
