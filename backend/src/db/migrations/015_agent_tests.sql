-- 015: a test of an agent's draft, and what Publish asks of it.
--
-- A test is tied to the exact draft it ran on (a fingerprint of the name, prompt, tools
-- and settings), so changing anything after a pass means testing again: a green tick
-- must never describe words that are no longer there.
CREATE TABLE agent_tests (
  id          text PRIMARY KEY CHECK (id ~ '^at_[0-9a-f]{12}$'),
  org_id      text REFERENCES organizations (id) ON DELETE CASCADE,
  agent_id    text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  passed      boolean NOT NULL,
  -- Why it did not pass, in a line a person can act on.
  note        text NOT NULL DEFAULT '',
  -- Every turn: what was said to the agent, the tools it used (dry run), what it said back.
  transcript  jsonb NOT NULL DEFAULT '[]',
  ran_by      text,
  ran_by_name text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_tests_agent ON agent_tests (agent_id, at DESC);

ALTER TABLE agent_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON agent_tests USING (
    org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    EXECUTE 'CREATE POLICY deny_api ON agent_tests AS RESTRICTIVE TO anon, authenticated USING (false) WITH CHECK (false)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_tests TO kaho_app;
  END IF;
END $$;
