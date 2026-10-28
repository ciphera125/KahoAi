-- 006: consent tracking on contacts, and a table for system error logs.

-- Contacts: whether the person has agreed to be called.
ALTER TABLE contacts ADD COLUMN consent text NOT NULL DEFAULT 'pending'
  CHECK (consent IN ('pending', 'given', 'refused'));

-- System errors the voice service reports to the Studio. Not call_events:
-- these are provider failures, webhook errors and other operational issues
-- that may or may not be tied to a single call.
CREATE TABLE error_logs (
  id       bigserial PRIMARY KEY,
  org_id   text REFERENCES organizations (id) ON DELETE CASCADE,
  call_id  text,
  level    text NOT NULL CHECK (level IN ('error', 'warn')),
  source   text NOT NULL,
  message  text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX error_logs_org_at ON error_logs (org_id, at DESC);

-- RLS: error_logs follow the same tenant policy as other org-scoped tables.
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON error_logs USING (
    org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');

-- Grant the app role access.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON error_logs TO kaho_app;
    GRANT USAGE ON SEQUENCE error_logs_id_seq TO kaho_app;
  END IF;
END $$;
