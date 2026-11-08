-- A permanent record of who changed what. Unlike the notification feed it is never trimmed, and the
-- application's own database role may only add to it and read it: no update, no delete.
CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  org_id  text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  role    text NOT NULL,
  action  text NOT NULL CHECK (char_length(action) <= 20),
  detail  text NOT NULL CHECK (char_length(detail) <= 300),
  ref     text
);
CREATE INDEX audit_log_org ON audit_log (org_id, at DESC, id DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON audit_log USING (
    org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    EXECUTE 'CREATE POLICY deny_api ON audit_log AS RESTRICTIVE TO anon, authenticated USING (false) WITH CHECK (false)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    -- Default privileges hand a new table's full rights to this role; take them back first.
    REVOKE ALL ON audit_log FROM kaho_app;
    GRANT SELECT, INSERT ON audit_log TO kaho_app;
    GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO kaho_app;
  END IF;
END $$;
