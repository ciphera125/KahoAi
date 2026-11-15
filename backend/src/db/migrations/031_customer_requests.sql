-- 031: what a customer asks Kaho for. A plan change or a free-text message, each a row an admin can see, answer and close.
-- (owner, 2026-11-15: "whatever is asked or whatever changes need to be done are shown in the notification panel".)
CREATE TABLE org_requests (
  id          text PRIMARY KEY CHECK (id ~ '^rq_[0-9a-f]{12}$'),
  org_id      text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('plan_change', 'message')),
  plan_id     text REFERENCES plans (id),
  message     text NOT NULL DEFAULT '' CHECK (char_length(message) <= 1000),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed', 'replaced')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  text,
  response    text CHECK (char_length(response) <= 500)
);
CREATE INDEX org_requests_org ON org_requests (org_id, created_at DESC);
CREATE INDEX org_requests_open ON org_requests (created_at DESC) WHERE status = 'open';

DO $$
BEGIN
  ALTER TABLE org_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE org_requests FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant ON org_requests USING (
      org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
    WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    CREATE POLICY deny_api ON org_requests AS RESTRICTIVE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    REVOKE ALL ON org_requests FROM kaho_app;
    GRANT SELECT, INSERT, UPDATE ON org_requests TO kaho_app;
  END IF;
END $$;
