-- Organizing the canvas: named, ordered, collapsible groups, and pinning.
CREATE TABLE canvas_groups (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    position  INTEGER NOT NULL DEFAULT 0,
    collapsed INTEGER NOT NULL DEFAULT 0
);

-- Pinned services show at the top; group_id places a service in a group
-- (cleared by the app when a group is deleted).
ALTER TABLE stacks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stacks ADD COLUMN group_id INTEGER;
ALTER TABLE deployments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployments ADD COLUMN group_id INTEGER;
