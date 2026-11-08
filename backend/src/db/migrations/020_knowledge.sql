-- Documents an agent can answer from during a call (a price list, an FAQ). Plain text, split into
-- passages and ranked when a question is asked, so nothing is added to every turn of every call.
CREATE TABLE knowledge_docs (
  id         text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  agent_id   text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_docs_agent ON knowledge_docs (org_id, agent_id, created_at);

ALTER TABLE knowledge_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_docs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON knowledge_docs USING (
    org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    EXECUTE 'CREATE POLICY deny_api ON knowledge_docs AS RESTRICTIVE TO anon, authenticated USING (false) WITH CHECK (false)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_docs TO kaho_app;
  END IF;
END $$;
