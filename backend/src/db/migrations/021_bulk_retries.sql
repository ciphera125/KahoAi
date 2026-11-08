-- Trying again when nobody answers: how many extra tries a bulk call makes, and how long it waits
-- between them. A number is only retried when its call went unanswered, never after a "no".
ALTER TABLE bulk_runs ADD COLUMN retries int NOT NULL DEFAULT 0 CHECK (retries BETWEEN 0 AND 3);
ALTER TABLE bulk_runs ADD COLUMN retry_after_hours int NOT NULL DEFAULT 4 CHECK (retry_after_hours BETWEEN 1 AND 24);
ALTER TABLE bulk_items ADD COLUMN attempts int NOT NULL DEFAULT 0;
ALTER TABLE bulk_items ADD COLUMN not_before timestamptz;
