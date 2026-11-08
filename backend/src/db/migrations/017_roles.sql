-- 017: more roles than owner, admin and member.
--
-- The four below an admin are manager, builder, operator and viewer (models/permissions.js). People
-- who were "member" could do the daily work but not run the organization, which is what a manager
-- is, so they become managers and lose nothing. Someone who joins from now on starts as a viewer.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
UPDATE memberships SET role = 'manager' WHERE role = 'member';
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('owner', 'admin', 'manager', 'builder', 'operator', 'viewer'));

-- users.role is the old column and is never read, but a new user's membership is copied from it by
-- this trigger. "member" there means a person who joined by invite: a viewer.
CREATE OR REPLACE FUNCTION users_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO memberships (user_id, org_id, role)
  VALUES (NEW.id, NEW.org_id, CASE NEW.role WHEN 'member' THEN 'viewer' ELSE NEW.role END)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
