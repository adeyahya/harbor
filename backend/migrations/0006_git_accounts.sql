-- Git credentials managed once in Settings instead of per service.
CREATE TABLE git_accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    -- Host the account is for; services on that host use it automatically.
    host       TEXT NOT NULL DEFAULT 'github.com',
    username   TEXT NOT NULL DEFAULT '',
    token      TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- NULL means "automatic": the account matching the repository's host.
ALTER TABLE deployments ADD COLUMN git_account_id INTEGER;
ALTER TABLE stacks ADD COLUMN git_account_id INTEGER;
