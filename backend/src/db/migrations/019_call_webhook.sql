-- A finished call is sent to the organization's webhook once. This records that it was claimed, so a
-- call whose events are re-sent never triggers a second delivery.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS webhook_sent_at timestamptz;
