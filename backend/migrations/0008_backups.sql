-- Where volume backups go: Google Drive, a local folder, or an rclone remote.
CREATE TABLE backup_destinations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    -- 'gdrive', 'local' or 'rclone'.
    kind       TEXT NOT NULL,
    -- Kind-specific settings as JSON, including secrets (OAuth tokens, rclone
    -- config); only a redacted view is sent to clients.
    config     TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

-- Scheduled backups of one volume to one destination.
CREATE TABLE backup_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    volume          TEXT NOT NULL,
    destination_id  INTEGER NOT NULL REFERENCES backup_destinations(id) ON DELETE CASCADE,
    -- Five-field cron expression in the server's time zone.
    schedule        TEXT NOT NULL,
    -- How many of this job's backups to keep; older ones are deleted. 0 keeps all.
    keep            INTEGER NOT NULL DEFAULT 7,
    -- Stop the containers using the volume while it's archived.
    stop_containers INTEGER NOT NULL DEFAULT 0,
    enabled         INTEGER NOT NULL DEFAULT 1,
    next_run_at     TEXT,
    -- The update of the most recent run; its status is the job's status.
    last_update_id  INTEGER,
    created_at      TEXT NOT NULL
);

CREATE INDEX backup_jobs_volume ON backup_jobs(volume);

-- Backups that were uploaded successfully.
CREATE TABLE backups (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    volume         TEXT NOT NULL,
    job_id         INTEGER REFERENCES backup_jobs(id) ON DELETE SET NULL,
    destination_id INTEGER REFERENCES backup_destinations(id) ON DELETE SET NULL,
    file_name      TEXT NOT NULL,
    -- How the destination finds the file again (a Drive file ID, or the name).
    remote_ref     TEXT NOT NULL,
    size           INTEGER NOT NULL,
    update_id      INTEGER,
    created_at     TEXT NOT NULL
);

CREATE INDEX backups_volume ON backups(volume, id DESC);
CREATE INDEX backups_job ON backups(job_id, id DESC);
