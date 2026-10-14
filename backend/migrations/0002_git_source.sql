-- Deployments can be built from a git repository instead of pulled as an image.
ALTER TABLE deployments ADD COLUMN source TEXT NOT NULL DEFAULT 'image';
ALTER TABLE deployments ADD COLUMN git_url TEXT NOT NULL DEFAULT '';
ALTER TABLE deployments ADD COLUMN git_branch TEXT NOT NULL DEFAULT 'main';
ALTER TABLE deployments ADD COLUMN build_context TEXT NOT NULL DEFAULT '.';
ALTER TABLE deployments ADD COLUMN dockerfile TEXT NOT NULL DEFAULT 'Dockerfile';
ALTER TABLE deployments ADD COLUMN build_args TEXT NOT NULL DEFAULT '';
ALTER TABLE deployments ADD COLUMN git_token TEXT NOT NULL DEFAULT '';
ALTER TABLE deployments ADD COLUMN auto_deploy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployments ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT '';
-- Commit of the last successful deploy, and the last commit a deploy was
-- triggered for (so a failing build isn't retried on every poll).
ALTER TABLE deployments ADD COLUMN last_commit TEXT NOT NULL DEFAULT '';
ALTER TABLE deployments ADD COLUMN last_commit_message TEXT NOT NULL DEFAULT '';
ALTER TABLE deployments ADD COLUMN last_seen_commit TEXT NOT NULL DEFAULT '';

UPDATE deployments SET webhook_secret = lower(hex(randomblob(20)));

-- Short context for an update, e.g. the commit a deploy built.
ALTER TABLE updates ADD COLUMN detail TEXT NOT NULL DEFAULT '';
