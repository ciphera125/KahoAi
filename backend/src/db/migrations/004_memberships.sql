-- More than one organization per account (owner, 2026-10-25: "more separate
-- environments"). A membership is a person's place and role in one
-- organization; a session carries the organization it is working in.
-- users.org_id stays as the one a sign-in lands on (the last one used);
-- users.role is no longer read.

CREATE TABLE memberships (
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id     text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX memberships_org ON memberships (org_id);
CREATE UNIQUE INDEX memberships_one_owner ON memberships (org_id) WHERE role = 'owner';

INSERT INTO memberships (user_id, org_id, role, created_at) SELECT id, org_id, role, created_at FROM users;

-- Whatever writes a user (sign-up, an import) gives them their membership too.
CREATE FUNCTION users_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO memberships (user_id, org_id, role) VALUES (NEW.id, NEW.org_id, NEW.role) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER users_membership AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION users_membership();

-- The owner of an organization no longer has to be one person per database row of users.
DROP INDEX users_one_owner;

ALTER TABLE sessions ADD COLUMN org_id text REFERENCES organizations (id) ON DELETE CASCADE;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON memberships USING (
    org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO kaho_app;
  END IF;
END $$;
