-- 018: settings that belong to the whole organization, and a picture people choose for themselves.
--
-- Organization settings are the admin's: a cap on how long any call can be, and calling hours that
-- hold for every agent, however the agent itself is set. They live in one JSON column because there
-- are few of them and they are read together.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
-- One of a short list of icons (models/avatars.js); null means the person's initials.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;
