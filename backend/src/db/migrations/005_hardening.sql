-- 005_hardening.sql: indexes for production traffic and safer foreign keys.
-- Fixes identified in the security audit of 2026-10-27.

-- ---- Indexes ---------------------------------------------------------------

-- Activity queries are always org-scoped and time-ordered.  The old index
-- lacked org_id, so every org-scoped query had to scan the whole table.
DROP INDEX IF EXISTS activity_at;
CREATE INDEX activity_org_at ON activity (org_id, at DESC);

-- Look up a bulk item by the call that was placed for it (the voice service
-- reports an outcome keyed by call_id).
CREATE INDEX bulk_items_call ON bulk_items (call_id) WHERE call_id IS NOT NULL;

-- Correlate Plivo's request_uuid with the call record.
CREATE INDEX calls_request_uuid ON calls (request_uuid) WHERE request_uuid IS NOT NULL;

-- Note: bulk_runs.created_by stores the user's display name, not their id,
-- so a foreign key to users is not appropriate.  The run's history should
-- survive even if the person's account is later removed.
