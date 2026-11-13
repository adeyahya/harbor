-- Docker security options for a deployment's container, one per line, e.g.
-- `systempaths=unconfined` or `apparmor=unconfined` for Rockchip MPP.
ALTER TABLE deployments ADD COLUMN security_opt TEXT NOT NULL DEFAULT '';
