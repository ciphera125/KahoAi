-- 033: meetings an agent booked on a call, through the organization's own Calendly (2026-11-22).
-- One row per meeting. UNIQUE (call_id, start_time) is what makes a booking happen once however many
-- times the model asks: the same time on the same call is the same meeting.

CREATE TABLE meeting_bookings (
  id             bigserial PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  call_id        text NOT NULL,
  agent_id       text REFERENCES agents (id) ON DELETE SET NULL,
  event_type     text NOT NULL,
  start_time     timestamptz NOT NULL,
  invitee_name   text NOT NULL,
  invitee_email  text NOT NULL,
  calendly_event text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, start_time)
);
CREATE INDEX meeting_bookings_org_at ON meeting_bookings (org_id, created_at DESC);

ALTER TABLE meeting_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON meeting_bookings USING (
    org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on')
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '') OR current_setting('app.bypass', true) = 'on');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaho_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_bookings TO kaho_app;
    GRANT USAGE ON SEQUENCE meeting_bookings_id_seq TO kaho_app;
  END IF;
END $$;
