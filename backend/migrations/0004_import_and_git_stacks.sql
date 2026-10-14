-- Importing containers that Harbor didn't create.
-- The container an imported deployment took over; replaced on its first deploy.
ALTER TABLE deployments ADD COLUMN adopted_container TEXT NOT NULL DEFAULT '';
-- Container labels (KEY=value lines), e.g. Traefik routing rules.
ALTER TABLE deployments ADD COLUMN labels TEXT NOT NULL DEFAULT '';

-- Stacks: run from an existing directory, and/or from a git repository.
-- Directory compose resolves relative paths against (imported stacks keep
-- their original one). Empty means Harbor's own stack folder.
ALTER TABLE stacks ADD COLUMN project_dir TEXT NOT NULL DEFAULT '';
-- "inline" (compose edited in Harbor) or "git".
ALTER TABLE stacks ADD COLUMN source TEXT NOT NULL DEFAULT 'inline';
ALTER TABLE stacks ADD COLUMN git_url TEXT NOT NULL DEFAULT '';
ALTER TABLE stacks ADD COLUMN git_branch TEXT NOT NULL DEFAULT '';
ALTER TABLE stacks ADD COLUMN git_token TEXT NOT NULL DEFAULT '';
-- Compose file inside the repository.
ALTER TABLE stacks ADD COLUMN compose_path TEXT NOT NULL DEFAULT 'compose.yaml';
ALTER TABLE stacks ADD COLUMN auto_deploy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stacks ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE stacks ADD COLUMN last_commit TEXT NOT NULL DEFAULT '';
ALTER TABLE stacks ADD COLUMN last_commit_message TEXT NOT NULL DEFAULT '';
ALTER TABLE stacks ADD COLUMN last_seen_commit TEXT NOT NULL DEFAULT '';

UPDATE stacks SET webhook_secret = lower(hex(randomblob(20)));
