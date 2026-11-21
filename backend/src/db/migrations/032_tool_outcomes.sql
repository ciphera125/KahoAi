-- 032: what each tool call came to, kept beside the line (2026-11-22).
--
-- The Tool calls page used to know two things, worked or not. It now tells six apart (worked, needed more
-- info, stopped by a safety check, failed, not switched on, not recorded), read from the tool's own reply
-- by backend/src/models/toolOutcome.js when the line arrives. Kept as a column so the page can filter and
-- count by it; rows from before are filled in at start-up (services/toolOutcomes.js). Safe to run again.
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE call_events DROP CONSTRAINT IF EXISTS call_events_outcome_check;
ALTER TABLE call_events ADD CONSTRAINT call_events_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('worked', 'needs_info', 'blocked', 'failed', 'not_attached', 'unknown'));
CREATE INDEX IF NOT EXISTS call_events_tools ON call_events (org_id, id) WHERE event IN ('tool', 'tool_rejected');
