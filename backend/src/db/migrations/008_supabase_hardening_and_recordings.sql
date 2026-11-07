-- 008: lock the Supabase public API out of every table, make transcript writes
-- idempotent, make call content searchable, and link recordings to calls.
-- Safe to run again: every statement is IF NOT EXISTS / DROP IF EXISTS / guarded.

-- 1a. schema_migrations had no row-level security: close it like the rest.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON schema_migrations;
CREATE POLICY system_only ON schema_migrations USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');

-- 1b. Supabase hands its public-API roles (anon, authenticated) full rights on every
-- new table. This app never uses them (it signs in as the owner and drops to
-- kaho_app), so take the rights away, stop future tables getting them, and add a
-- RESTRICTIVE policy so that even a regrant plus `SET app.bypass = 'on'` shows nothing.
DO $$
DECLARE r text; t text; roles text[];
BEGIN
  SELECT coalesce(array_agg(rolname::text), '{}') INTO roles FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOREACH r IN ARRAY roles LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
  END LOOP;
  IF array_length(roles, 1) > 0 THEN
    FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity LOOP
      EXECUTE format('DROP POLICY IF EXISTS deny_api ON %I', t);
      EXECUTE format('CREATE POLICY deny_api ON %I AS RESTRICTIVE FOR ALL TO %s USING (false) WITH CHECK (false)',
        t, (SELECT string_agg(quote_ident(x), ', ') FROM unnest(roles) x));
    END LOOP;
  END IF;
END $$;

-- 1c. A transaction the app forgets to close must not hold locks for long.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    ALTER ROLE kaho_app SET idle_in_transaction_session_timeout = '15s';
  END IF;
END $$;

-- 2. Idempotent transcript writes: the same line sent twice is stored once.
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS dedupe text;
UPDATE call_events e SET dedupe = d.h
FROM (SELECT id, h, row_number() OVER (PARTITION BY h ORDER BY id) AS rn
      FROM (SELECT id, md5(concat_ws('|', call_id, coalesce((extract(epoch FROM at) * 1000)::bigint::text, ''), event,
              coalesce(role, ''), coalesce(name, ''), coalesce(text, ''))) AS h FROM call_events) x) d
WHERE e.id = d.id AND d.rn = 1 AND e.dedupe IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS call_events_dedupe ON call_events (dedupe);

-- 3. Findable: full-text over what was said ('simple' keeps Hindi and English words as they are).
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED;
CREATE INDEX IF NOT EXISTS call_events_tsv ON call_events USING gin (tsv);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS summary_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(summary, ''))) STORED;
CREATE INDEX IF NOT EXISTS calls_summary_tsv ON calls USING gin (summary_tsv);
-- Append-only and time-ordered: a BRIN index is tiny and fast for time ranges.
CREATE INDEX IF NOT EXISTS call_events_at_brin ON call_events USING brin (at);

-- 4. Each call knows its recording (the file lives in the private Storage bucket).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_path text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_bytes bigint CHECK (recording_bytes > 0);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_mime text CHECK (recording_mime IN ('audio/opus', 'audio/ogg', 'audio/wav'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_at timestamptz;
