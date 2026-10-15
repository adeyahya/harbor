-- Promote deployments run an artifact of another deployment (e.g. staging →
-- production) instead of pulling or building one. With auto_deploy on, they
-- promote each successful deploy of their upstream.
ALTER TABLE deployments ADD COLUMN upstream_id INTEGER;
