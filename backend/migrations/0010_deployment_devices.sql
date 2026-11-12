-- Host devices passed into a deployment's container, one per line as
-- `/dev/host[:/dev/container[:permissions]]`, e.g. for hardware acceleration.
ALTER TABLE deployments ADD COLUMN devices TEXT NOT NULL DEFAULT '';
-- Extra groups the container's user joins (names or ids, one per line),
-- e.g. `video` or `render` for access to those devices.
ALTER TABLE deployments ADD COLUMN group_add TEXT NOT NULL DEFAULT '';
