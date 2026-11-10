-- 025: what Kaho Builder was asked, a record of every tool made or changed, and where each
-- call's record was filed in Storage.
--
-- builder_history and tool_log are append-only for the application (like audit_log): an edited
-- prompt is a new row that points at the one it came from, so what was originally asked is never
-- rewritten. archive_path / archived_at say that a finished call's JSON record is in the bucket's
-- calls/ folder.

CREATE TABLE builder_history (
  id          bigserial PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  agent_id    text,
  actor       text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  prompt      text NOT NULL CHECK (char_length(prompt) <= 600),
  reply       text NOT NULL DEFAULT '' CHECK (char_length(reply) <= 2000),
  outcome     text NOT NULL CHECK (outcome IN ('built', 'asked', 'failed', 'refused')),
  kind        text CHECK (kind IN ('write_down', 'look_up')),
  names       jsonb NOT NULL DEFAULT '[]'::jsonb,
  edited_from bigint REFERENCES builder_history (id)
);
CREATE INDEX builder_history_org ON builder_history (org_id, at DESC, id DESC);

CREATE TABLE tool_log (
  id         bigserial PRIMARY KEY,
  org_id     text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  role       text NOT NULL,
  action     text NOT NULL CHECK (action IN ('built', 'undone', 'created', 'updated', 'removed')),
  source     text NOT NULL CHECK (source IN ('builder', 'studio')),
  kind       text,
  tool_name  text,
  tool_label text NOT NULL,
  agent_id   text,
  history_id bigint REFERENCES builder_history (id),
  detail     text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 300)
);
CREATE INDEX tool_log_org ON tool_log (org_id, at DESC, id DESC);

ALTER TABLE calls ADD COLUMN IF NOT EXISTS archive_path text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS archived_at timestamptz;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_history', 'tool_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (
        org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')$p$, t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
      EXECUTE format('CREATE POLICY deny_api ON %I AS RESTRICTIVE TO anon, authenticated USING (false) WITH CHECK (false)', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
      EXECUTE format('REVOKE ALL ON %I FROM kaho_app', t);
      EXECUTE format('GRANT SELECT, INSERT ON %I TO kaho_app', t);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO kaho_app', t || '_id_seq');
    END IF;
  END LOOP;
END $$;
