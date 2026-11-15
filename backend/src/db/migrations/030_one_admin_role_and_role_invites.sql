-- 030: one role in charge, and invite codes that carry the role they give.
--
-- (owner, 2026-11-15) "keep admin only": an organization's creator is simply an admin, with exactly the powers every
-- admin has. What the owner role really did was make sure an organization could never be left without anyone in
-- charge; the application keeps that as a rule (an admin cannot change their own role or remove themselves, and the
-- admin site refuses to demote the last one), so nobody needs to be a different kind of admin.
--
-- Safe to run on a database that already has organizations: every 'owner' becomes 'admin', nothing is removed, and no
-- permission changes (owner and admin had the same ones).

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
UPDATE memberships SET role = 'admin' WHERE role = 'owner';
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('admin', 'manager', 'builder', 'operator', 'viewer'));
DROP INDEX IF EXISTS memberships_one_owner;

-- users.role is the old column nothing reads, but a new user's membership is copied from it by this trigger.
UPDATE users SET role = 'admin' WHERE role = 'owner';
CREATE OR REPLACE FUNCTION users_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO memberships (user_id, org_id, role)
  VALUES (NEW.id, NEW.org_id, CASE NEW.role WHEN 'member' THEN 'viewer' WHEN 'owner' THEN 'admin' ELSE NEW.role END)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

-- An invite code is for one role, one person, one week. An organization may have several open at once, for any
-- role, so the unique-per-organization rule goes. An admin is never invited directly: invite, then promote.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'viewer';
ALTER TABLE invites ADD CONSTRAINT invites_role_check CHECK (role IN ('manager', 'builder', 'operator', 'viewer'));
ALTER TABLE invites ADD COLUMN IF NOT EXISTS made_by text;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_org_id_key;
CREATE INDEX IF NOT EXISTS invites_org ON invites (org_id, created_at DESC);
