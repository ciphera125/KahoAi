-- 014: enough about each tool call to show a readable history.
--
-- The transcript already carried what a tool was sent and what it answered; ingest threw
-- it away and kept only the name, so "why did that call go wrong" could not be answered
-- from the Studio. These three columns keep the rest.
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS turn integer;   -- which caller turn it happened on
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS secs real;      -- how long the tool took
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS ok boolean;     -- whether it did what was asked
CREATE INDEX IF NOT EXISTS call_events_tools ON call_events (org_id, event, at DESC) WHERE event IN ('tool', 'tool_rejected');
