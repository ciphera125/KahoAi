-- 013: tools a customer defines themselves, calling their own API.
--
-- The Studio makes the request, not the voice service: the auth header is decrypted
-- here, used, and never leaves this process. The model is told the tool's name, what it
-- is for and what to collect, never the URL, the headers or anything behind them.

CREATE TABLE custom_tools (
  id             text PRIMARY KEY CHECK (id ~ '^ct_[0-9a-f]{12}$'),
  org_id         text REFERENCES organizations (id) ON DELETE CASCADE,
  -- The machine name the model calls, made from the label and fixed from then on: a
  -- published prompt and an agent's tool list both refer to it.
  name           text NOT NULL,
  label          text NOT NULL,
  -- When the agent should use it. This is the description the model reads.
  description    text NOT NULL DEFAULT '',
  method         text NOT NULL DEFAULT 'POST' CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH')),
  url            text NOT NULL,
  -- Headers, including any key or token, sealed with SECRETS_KEY (crypto.encryptJson).
  -- Never selected into anything that leaves the server.
  headers_sealed text,
  body_template  text NOT NULL DEFAULT '',
  -- [{key, label, type, description, required, example}]: what the agent collects.
  inputs         jsonb NOT NULL DEFAULT '[]',
  -- What the agent says while the request is in flight, so nobody hears silence.
  say_while_waiting text NOT NULL DEFAULT '',
  timeout_ms     integer NOT NULL DEFAULT 6000,
  -- {variable_name: "$.path.in.the.response"}, read back as {{variable}}.
  extract        jsonb NOT NULL DEFAULT '{}',
  last_test_at   timestamptz,
  last_test_ok   boolean,
  last_test_note text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX custom_tools_org ON custom_tools (org_id, label);

ALTER TABLE custom_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_tools FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON custom_tools USING (
    org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    EXECUTE 'CREATE POLICY deny_api ON custom_tools AS RESTRICTIVE TO anon, authenticated USING (false) WITH CHECK (false)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON custom_tools TO kaho_app;
  END IF;
END $$;
