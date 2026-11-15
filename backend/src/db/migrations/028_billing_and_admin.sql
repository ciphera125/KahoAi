-- 028: plans, subscriptions, the minute wallet, top-ups, and the separate admin accounts.
--
-- Money is whole paise and time is whole minutes, so nothing here is ever a float.
-- A plan is a template; a subscription copies its terms (jsonb) when it starts, so editing a
-- plan later never silently changes what an existing customer was promised: the admin edits
-- the customer's own terms instead. Existing organizations are grandfathered as `unmetered`
-- (active, no minute limit) so nothing that works today stops; an admin switches that off
-- when a plan is assigned.

CREATE TABLE plans (
  id              text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  sort            int NOT NULL DEFAULT 0,
  custom          boolean NOT NULL DEFAULT false,   -- terms are set per customer by Kaho (Enterprise)
  highlighted     boolean NOT NULL DEFAULT false,   -- "Most chosen"
  active          boolean NOT NULL DEFAULT true,
  price_paise     bigint CHECK (price_paise >= 0),  -- per month; null while custom
  minutes_included int CHECK (minutes_included >= 0),
  approx_calls    int CHECK (approx_calls >= 0),
  rate_paise      int CHECK (rate_paise >= 0),      -- "works out to", per minute
  rate_is_from    boolean NOT NULL DEFAULT false,   -- "From ₹3.75/min"
  extra_paise     int CHECK (extra_paise >= 0),     -- the price of a minute beyond the plan: what a top-up costs
  simultaneous    int CHECK (simultaneous BETWEEN 1 AND 100),
  log_days        int CHECK (log_days BETWEEN 1 AND 3650),
  support         text NOT NULL DEFAULT '' CHECK (char_length(support) <= 80),
  languages       text NOT NULL DEFAULT 'Hindi + English' CHECK (char_length(languages) <= 80),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The rate card of 2026-11-15.
INSERT INTO plans (id, name, sort, custom, highlighted, price_paise, minutes_included, approx_calls, rate_paise, rate_is_from,
                   extra_paise, simultaneous, log_days, support, languages) VALUES
  ('start',      'Start',      1, false, false,   549900, 1100,  440, 500, false, 550,  2,  30, 'Email',                  'Hindi + English'),
  ('growth',     'Growth',     2, false, true,    899900, 2000,  800, 450, false, 500,  5,  90, 'Email + priority chat',  'Hindi + English'),
  ('scale',      'Scale',      3, false, false,  2199900, 5500, 2200, 400, false, 450, 10, 365, 'Priority + onboarding call', 'Hindi + English'),
  ('enterprise', 'Enterprise', 4, true,  false,     NULL, NULL, NULL, 375, true, NULL, NULL, NULL, 'Dedicated manager',     'Hindi + English');

CREATE TABLE subscriptions (
  org_id            text PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  plan_id           text NOT NULL REFERENCES plans (id),
  status            text NOT NULL CHECK (status IN ('pending', 'active', 'expired', 'suspended', 'cancelled')),
  terms             jsonb NOT NULL DEFAULT '{}'::jsonb,
  unmetered         boolean NOT NULL DEFAULT false,
  balance_minutes   int NOT NULL DEFAULT 0,          -- kept in step with minute_ledger by a trigger
  period_start      timestamptz,
  period_end        timestamptz,
  requested_plan_id text REFERENCES plans (id),      -- an active customer asking to move to another plan
  request_note      text CHECK (char_length(request_note) <= 300),
  chosen_at         timestamptz NOT NULL DEFAULT now(),
  activated_at      timestamptz,
  activated_by      text,
  renewal_notified_at timestamptz,
  note              text CHECK (char_length(note) <= 300),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_status ON subscriptions (status);
CREATE INDEX subscriptions_period_end ON subscriptions (period_end) WHERE status = 'active';

CREATE TABLE minute_ledger (
  id       bigserial PRIMARY KEY,
  org_id   text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  kind     text NOT NULL CHECK (kind IN ('plan', 'topup', 'usage', 'adjust')),
  minutes  int NOT NULL CHECK (minutes <> 0),
  call_id  text,
  topup_id text,
  actor    text NOT NULL DEFAULT 'system' CHECK (char_length(actor) <= 80),
  note     text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200)
);
CREATE INDEX minute_ledger_org ON minute_ledger (org_id, at DESC, id DESC);
CREATE UNIQUE INDEX minute_ledger_usage_call ON minute_ledger (call_id) WHERE kind = 'usage';
CREATE UNIQUE INDEX minute_ledger_topup ON minute_ledger (topup_id) WHERE kind = 'topup';

-- The balance is whatever the ledger adds up to; this keeps the stored copy exact, whoever writes.
CREATE FUNCTION minute_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE subscriptions SET balance_minutes = balance_minutes + NEW.minutes, updated_at = now() WHERE org_id = NEW.org_id;
  ELSE
    UPDATE subscriptions SET balance_minutes = balance_minutes + (NEW.minutes - OLD.minutes), updated_at = now() WHERE org_id = NEW.org_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER minute_ledger_balance AFTER INSERT OR UPDATE OF minutes ON minute_ledger
  FOR EACH ROW EXECUTE FUNCTION minute_ledger_balance();

-- Money entries are never rewritten: only a call's own usage line may change (its length can be corrected).
CREATE FUNCTION minute_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind <> 'usage' OR NEW.kind <> 'usage' OR NEW.org_id <> OLD.org_id OR NEW.call_id IS DISTINCT FROM OLD.call_id THEN
    RAISE EXCEPTION 'the minute ledger only allows a usage line to change its minutes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER minute_ledger_guard BEFORE UPDATE ON minute_ledger FOR EACH ROW EXECUTE FUNCTION minute_ledger_guard();

CREATE TABLE topups (
  id              text PRIMARY KEY CHECK (id ~ '^tp_[0-9a-f]{12}$'),
  org_id          text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  requested_by    text NOT NULL,
  minutes         int NOT NULL CHECK (minutes BETWEEN 1 AND 100000),
  rate_paise      int NOT NULL CHECK (rate_paise >= 0),
  amount_paise    bigint NOT NULL CHECK (amount_paise >= 0),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'rejected', 'cancelled')),
  reference       text NOT NULL CHECK (reference ~ '^KAHO-[0-9A-F]{8}$'),
  note            text CHECK (char_length(note) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  decided_by      text
);
CREATE UNIQUE INDEX topups_reference ON topups (reference);
CREATE INDEX topups_org ON topups (org_id, created_at DESC);
CREATE INDEX topups_pending ON topups (created_at) WHERE status = 'pending';

-- --- the admin side: its own accounts, sessions and record, apart from the Studio's --------

CREATE TABLE admins (
  id            text PRIMARY KEY CHECK (id ~ '^ad_[0-9a-f]{12}$'),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  salt          text NOT NULL,
  hash          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  disabled_at   timestamptz
);

CREATE TABLE admin_sessions (
  token_hash   text PRIMARY KEY,
  admin_id     text NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text
);
CREATE INDEX admin_sessions_admin ON admin_sessions (admin_id);

-- Everything an admin changes, who did it and to whom. Append-only, like the organizations' audit log.
CREATE TABLE admin_audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  admin_email text NOT NULL,
  action      text NOT NULL CHECK (char_length(action) <= 40),
  org_id      text,
  target      text,
  detail      text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 500),
  ip          text
);
CREATE INDEX admin_audit_at ON admin_audit (at DESC, id DESC);
CREATE INDEX admin_audit_org ON admin_audit (org_id, at DESC);

-- A one-use, 60-second hand-off from the admin site to the Studio ("open as this person").
CREATE TABLE impersonations (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id      text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  admin_email text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

ALTER TABLE sessions ADD COLUMN impersonated_by text;
ALTER TABLE users ADD COLUMN disabled_at timestamptz;

-- Existing organizations keep working exactly as before: active, no minute limit, until an admin assigns a plan.
INSERT INTO subscriptions (org_id, plan_id, status, terms, unmetered, activated_at, activated_by, note)
SELECT id, 'enterprise', 'active', '{"simultaneous": 10}'::jsonb, true, now(), 'migration',
       'Existing organization: no minute limit until a plan is assigned'
FROM organizations;

-- --- row-level security and rights, the same way as every other table --------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'minute_ledger', 'topups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (
        org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')$p$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['plans', 'admins', 'admin_sessions', 'admin_audit', 'impersonations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY system_only ON %I USING (current_setting('app.bypass', true) = 'on')
      WITH CHECK (current_setting('app.bypass', true) = 'on')$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    FOREACH t IN ARRAY ARRAY['subscriptions', 'minute_ledger', 'topups', 'plans', 'admins', 'admin_sessions', 'admin_audit', 'impersonations'] LOOP
      EXECUTE format('CREATE POLICY deny_api ON %I AS RESTRICTIVE TO anon, authenticated USING (false) WITH CHECK (false)', t);
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    FOREACH t IN ARRAY ARRAY['plans', 'subscriptions', 'minute_ledger', 'topups', 'admins', 'admin_sessions', 'admin_audit', 'impersonations'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM kaho_app', t);
    END LOOP;
    GRANT SELECT, INSERT, UPDATE ON plans, subscriptions, minute_ledger, topups, admins TO kaho_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON admin_sessions, impersonations TO kaho_app;
    GRANT SELECT, INSERT ON admin_audit TO kaho_app;
    GRANT USAGE, SELECT ON SEQUENCE minute_ledger_id_seq, admin_audit_id_seq TO kaho_app;
  END IF;
END $$;
