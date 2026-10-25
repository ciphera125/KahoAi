-- Bulk calls: a list of people called through one agent, a few at a time.
--
-- A run is the list and its settings; each row of the list is an item. The
-- runner (services/bulkRunner.js) moves items queued -> calling -> done, or to
-- skipped/failed with a reason. A dial is never retried, so an item leaves
-- "calling" only through the call's reported end or the run's own deadline.

CREATE TABLE bulk_runs (
  id          text PRIMARY KEY CHECK (id ~ '^bk_[0-9a-f]{12}$'),
  org_id      text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  agent_id    text REFERENCES agents (id) ON DELETE SET NULL,
  from_id     text NOT NULL,
  parallel    int NOT NULL CHECK (parallel BETWEEN 1 AND 10),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'done', 'cancelled')),
  waiting     text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bulk_runs_org ON bulk_runs (org_id, created_at DESC);
CREATE INDEX bulk_runs_running ON bulk_runs (status) WHERE status = 'running';

CREATE TABLE bulk_items (
  id          bigserial PRIMARY KEY,
  run_id      text NOT NULL REFERENCES bulk_runs (id) ON DELETE CASCADE,
  org_id      text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  position    int NOT NULL,
  name        text NOT NULL,
  number      text NOT NULL,
  status      text NOT NULL CHECK (status IN ('queued', 'dialling', 'calling', 'done', 'skipped', 'failed')),
  reason      text,
  call_id     text,
  outcome     text,
  placed_at   timestamptz,
  finished_at timestamptz
);
CREATE INDEX bulk_items_run ON bulk_items (run_id, position);
CREATE INDEX bulk_items_org ON bulk_items (org_id);
CREATE INDEX bulk_items_open ON bulk_items (run_id, status) WHERE status IN ('queued', 'dialling', 'calling');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bulk_runs', 'bulk_items']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (
        org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON bulk_runs, bulk_items TO kaho_app;
    GRANT USAGE, SELECT ON SEQUENCE bulk_items_id_seq TO kaho_app;
  END IF;
END $$;
