-- 010: answers the agent collected on a call ("Save What the Caller Says").
--
-- The questions themselves live on the agent, in settings.capture_fields, so they are
-- drafted, published and rolled back with everything else (migration 009). This is where
-- the answers land.
--
-- org_id and contact_id are never taken from the model or the request: they are looked up
-- from the call row, server side. The model only ever says which field and what it heard.

CREATE TABLE call_answers (
  id         bigserial PRIMARY KEY,
  org_id     text REFERENCES organizations (id) ON DELETE CASCADE,
  call_id    text NOT NULL,
  contact_id text REFERENCES contacts (id) ON DELETE SET NULL,
  field_key  text NOT NULL,
  label      text NOT NULL DEFAULT '',
  kind       text NOT NULL DEFAULT 'text',
  value      text NOT NULL,
  -- What the caller actually said, kept beside the tidy value so a wrong reading can be
  -- seen for what it was. Masked on the way in, like every other piece of call content.
  raw_text   text NOT NULL DEFAULT '',
  source     text NOT NULL DEFAULT 'tool_call',
  -- call + field + turn: the same answer sent twice (a retry) updates one row instead of
  -- making a second.
  idem       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idem)
);
CREATE INDEX call_answers_call ON call_answers (call_id, at);
CREATE INDEX call_answers_contact ON call_answers (contact_id, at DESC);
CREATE INDEX call_answers_org_field ON call_answers (org_id, field_key, at DESC);

ALTER TABLE call_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_answers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON call_answers USING (
    org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    EXECUTE 'CREATE POLICY deny_api ON call_answers AS RESTRICTIVE TO anon, authenticated USING (false) WITH CHECK (false)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON call_answers TO kaho_app;
    GRANT USAGE ON SEQUENCE call_answers_id_seq TO kaho_app;
  END IF;
END $$;
