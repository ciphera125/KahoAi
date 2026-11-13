-- 027: errors can be acknowledged (someone has seen them and dealt with them).
ALTER TABLE error_logs ADD COLUMN acknowledged_at timestamptz;
ALTER TABLE error_logs ADD COLUMN acknowledged_by text;
CREATE INDEX error_logs_org_open ON error_logs (org_id, at DESC) WHERE acknowledged_at IS NULL;
