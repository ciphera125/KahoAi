-- Organizations and strict tenant isolation.
--
-- Every row of customer data carries org_id. The application filters by it in
-- every query, and PostgreSQL row-level security enforces it again underneath:
-- a query that forgets the filter sees nothing, it never sees another team.
-- The app connects through role kaho_app (no superuser, no BYPASSRLS), and
-- must set app.org_id for the transaction (or app.bypass = 'on' for the few
-- system paths: sign-in, the voice service, imports).

CREATE TABLE organizations (
  id         text PRIMARY KEY CHECK (id ~ '^org_[0-9a-f]{12}$'),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The existing single workspace becomes the first organization.
DO $$
DECLARE first_org text := 'org_' || substr(md5(random()::text), 1, 12);
BEGIN
  IF EXISTS (SELECT 1 FROM users) THEN
    INSERT INTO organizations (id, name)
    SELECT first_org, coalesce(nullif((SELECT company FROM users WHERE role = 'owner' LIMIT 1), ''), 'My organization');
    PERFORM set_config('kaho.first_org', first_org, true);
  END IF;
END $$;

-- Roles: one owner per organization, any number of admins and members.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'admin', 'member'));
DROP INDEX users_one_owner;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'agents', 'prompts', 'prompt_versions', 'routes', 'phone_numbers', 'tags',
    'contacts', 'contact_numbers', 'contact_tags', 'contact_number_tags', 'activity', 'calls', 'call_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN org_id text REFERENCES organizations (id) ON DELETE CASCADE', t);
    EXECUTE format('UPDATE %I SET org_id = nullif(current_setting(''kaho.first_org'', true), '''')', t);
    IF t <> 'calls' AND t <> 'call_events' THEN  -- a call the voice service reports may not be matched yet
      EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET NOT NULL', t);
    END IF;
    EXECUTE format('CREATE INDEX %I ON %I (org_id)', t || '_org', t);
  END LOOP;
END $$;

CREATE UNIQUE INDEX users_one_owner ON users (org_id) WHERE role = 'owner';
DROP INDEX tags_name;
CREATE UNIQUE INDEX tags_name ON tags (org_id, lower(name));
DROP INDEX phone_numbers_one_default;
CREATE UNIQUE INDEX phone_numbers_one_default ON phone_numbers (org_id) WHERE is_default;
DROP INDEX calls_started;
CREATE INDEX calls_started ON calls (org_id, started_at DESC NULLS LAST);
DROP INDEX contacts_created;
CREATE INDEX contacts_created ON contacts (org_id, created_at, id);
CREATE INDEX contacts_name ON contacts (org_id, lower(name));

-- Invites belong to an organization; one live code each.
DROP TABLE invites;
CREATE TABLE invites (
  code       text PRIMARY KEY,
  org_id     text NOT NULL UNIQUE REFERENCES organizations (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Sessions end after a while unused, as well as after their absolute life.
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

-- Row-level security on every table that holds customer data. FORCE applies it
-- to the table owner too.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'agents', 'prompts', 'prompt_versions', 'routes', 'phone_numbers', 'tags',
    'contacts', 'contact_numbers', 'contact_tags', 'contact_number_tags', 'activity', 'calls', 'call_events', 'invites']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (
        org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')$p$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['organizations', 'sessions', 'devices', 'login_failures', 'meta']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY system_only ON %I USING (current_setting('app.bypass', true) = 'on')
      WITH CHECK (current_setting('app.bypass', true) = 'on')$p$, t);
  END LOOP;
END $$;

-- The application's role: can read and write rows, cannot skip the policies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    BEGIN
      CREATE ROLE kaho_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'could not create role kaho_app; grant it on the managed database instead';
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    EXECUTE format('GRANT kaho_app TO %I', current_user);
    GRANT USAGE ON SCHEMA public TO kaho_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kaho_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kaho_app;
    REVOKE ALL ON schema_migrations FROM kaho_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kaho_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO kaho_app;
  END IF;
END $$;
