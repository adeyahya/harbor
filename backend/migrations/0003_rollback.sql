-- What a deploy ran, so it can be rolled back to: the exact image (a built
-- tag or an image ID) and a JSON snapshot of the runtime settings.
ALTER TABLE updates ADD COLUMN artifact TEXT NOT NULL DEFAULT '';
ALTER TABLE updates ADD COLUMN snapshot TEXT NOT NULL DEFAULT '';
