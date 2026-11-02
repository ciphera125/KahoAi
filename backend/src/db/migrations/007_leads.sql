-- 007: leads captured by the voice service's capture_lead tool, mirrored to the Studio.

CREATE TABLE leads (
  id           bigserial PRIMARY KEY,
  org_id       text REFERENCES organizations (id) ON DELETE CASCADE,
  call_id      text,
  name         text NOT NULL,
  phone        text NOT NULL,
  phone_source text NOT NULL CHECK (phone_source IN ('caller_stated', 'call_metadata')),
  reason       text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_org_at ON leads (org_id, at DESC);

-- RLS: leads follow the same tenant policy as other org-scoped tables.
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON leads USING (
    org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');

-- Grant the app role access.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO kaho_app;
    GRANT USAGE ON SEQUENCE leads_id_seq TO kaho_app;
  END IF;
END $$;
