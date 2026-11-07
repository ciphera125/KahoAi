-- 009: an agent now has a draft and published versions.
--
-- Until now every save went live on the agent's next call: there was no way to work on
-- a prompt without the next caller hearing it. The agents row becomes the draft; a
-- published version is a snapshot of it, and a call reads the snapshot. A call that is
-- already running keeps the version it started with, because its settings are read once
-- when it is answered.

CREATE TABLE agent_versions (
  id                text PRIMARY KEY CHECK (id ~ '^av_[0-9a-f]{12}$'),
  agent_id          text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  org_id            text REFERENCES organizations (id) ON DELETE CASCADE,
  number            integer NOT NULL,
  name              text NOT NULL DEFAULT '',
  prompt            text NOT NULL DEFAULT '',
  tools             text[] NOT NULL DEFAULT '{}',
  settings          jsonb NOT NULL DEFAULT '{}',
  published_at      timestamptz NOT NULL DEFAULT now(),
  -- Who published it, kept as plain text as well: the history must still read correctly
  -- after the person leaves the organization and their row is gone.
  published_by      text,
  published_by_name text NOT NULL DEFAULT '',
  note              text NOT NULL DEFAULT '',
  -- Problems an admin chose to publish over, each {code, found, message}. Kept for good:
  -- this is the record of who decided the check was wrong.
  overrides         jsonb NOT NULL DEFAULT '[]',
  UNIQUE (agent_id, number)
);
CREATE INDEX agent_versions_agent ON agent_versions (agent_id, number DESC);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS live_version_id text REFERENCES agent_versions (id) ON DELETE SET NULL;

-- Which version answered a call, for the call's history.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS agent_version integer;

-- Every agent that exists today becomes published version 1, exactly as it is now, so
-- nothing changes for anyone the day this lands.
INSERT INTO agent_versions (id, agent_id, org_id, number, name, prompt, tools, settings, published_at, note)
SELECT 'av_' || substr(md5(random()::text || a.id), 1, 12), a.id, a.org_id, 1, a.name,
       coalesce((SELECT v.prompt FROM prompt_versions v
                 WHERE v.prompt_id = a.active_prompt_id AND v.org_id = a.org_id
                 ORDER BY v.seq DESC LIMIT 1), ''),
       a.tools, a.settings, a.created_at, 'The agent as it stood before drafts existed'
FROM agents a
WHERE NOT EXISTS (SELECT 1 FROM agent_versions av WHERE av.agent_id = a.id);

UPDATE agents a SET live_version_id =
  (SELECT av.id FROM agent_versions av WHERE av.agent_id = a.id ORDER BY av.number DESC LIMIT 1)
WHERE a.live_version_id IS NULL;

-- Same tenant policy as every other org-scoped table.
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON agent_versions USING (
    org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');

-- Supabase's public-API roles must never reach it (migration 008's rule, for a new table).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    EXECUTE 'CREATE POLICY deny_api ON agent_versions AS RESTRICTIVE TO anon, authenticated USING (false) WITH CHECK (false)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_versions TO kaho_app;
  END IF;
END $$;
