-- 016: a call's transcript is saved in Storage beside its recording, under the same readable name.
-- The text is built from the stored (masked) lines, so it carries no more than the Studio shows.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_path text;
