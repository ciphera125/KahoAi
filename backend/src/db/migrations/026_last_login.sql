-- 026: when each person last signed in. Sessions are deleted on sign-out and on expiry, so they
-- cannot answer this; it is written when a session starts. Existing people get their newest
-- surviving session, or the day they signed up.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
UPDATE users u SET last_login_at = COALESCE((SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id), u.created_at)
  WHERE last_login_at IS NULL;
