-- Extra compose files for git stacks, applied after `compose_path` with one
-- `-f` each, in order (one path per line). Used for override files such as
-- `docker-compose.rockchip.yml` that add devices or other host settings.
ALTER TABLE stacks ADD COLUMN compose_overrides TEXT NOT NULL DEFAULT '';
