-- 011: tasks, and the API keys that let another system push them in.
--
-- Tasks are what a reminder agent calls people about. They can be typed in the Studio or
-- pushed in by a customer's own system; a CSV upload is meant to land here later, which
-- is why `source` is a plain list rather than a boolean.

CREATE TABLE tasks (
  id           text PRIMARY KEY CHECK (id ~ '^tk_[0-9a-f]{12}$'),
  org_id       text REFERENCES organizations (id) ON DELETE CASCADE,
  contact_id   text REFERENCES contacts (id) ON DELETE CASCADE,
  title        text NOT NULL,
  -- When it is due, as an instant. Everything shown and said is worked out in the
  -- organization's time zone (Asia/Kolkata) from this.
  due_at       timestamptz,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  source       text NOT NULL DEFAULT 'studio' CHECK (source IN ('studio', 'api', 'call', 'csv')),
  -- Set by the caller's own system when it pushes a task, so pushing the same task twice
  -- does not make two. Also used by the tools: call + tool + turn.
  external_id  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (org_id, external_id)
);
CREATE INDEX tasks_org_due ON tasks (org_id, due_at);
CREATE INDEX tasks_contact ON tasks (contact_id, due_at);
CREATE INDEX tasks_org_status ON tasks (org_id, status, due_at);

-- A key another system uses to push tasks in. Only the hash is kept: the key itself is
-- shown once, when it is made, and never again.
CREATE TABLE api_keys (
  id           text PRIMARY KEY CHECK (id ~ '^ak_[0-9a-f]{12}$'),
  org_id       text REFERENCES organizations (id) ON DELETE CASCADE,
  name         text NOT NULL DEFAULT '',
  -- The first few characters, so a person can tell two keys apart in the list.
  prefix       text NOT NULL DEFAULT '',
  key_hash     text NOT NULL,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX api_keys_hash ON api_keys (key_hash);
CREATE INDEX api_keys_org ON api_keys (org_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks', 'api_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (
        org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')$p$, t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
      EXECUTE format('CREATE POLICY deny_api ON %I AS RESTRICTIVE TO anon, authenticated USING (false) WITH CHECK (false)', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO kaho_app', t);
    END IF;
  END LOOP;
END $$;
