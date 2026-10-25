-- Kaho AI Studio, first schema. Mirrors the Python Studio's JSON stores
-- (data/*.json) so they can be imported as they are.

CREATE TABLE users (
  id         text PRIMARY KEY CHECK (id ~ '^u_[0-9a-f]{12}$'),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  email      text NOT NULL UNIQUE CHECK (email = lower(email)),
  company    text NOT NULL DEFAULT '' CHECK (length(company) <= 80),
  role       text NOT NULL CHECK (role IN ('owner', 'member')),
  salt       text NOT NULL,
  hash       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at    timestamptz
);
-- One owner per workspace, enforced by the database, not only by the code.
CREATE UNIQUE INDEX users_one_owner ON users (role) WHERE role = 'owner';

CREATE TABLE sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id, expires_at);

CREATE TABLE devices (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user ON devices (user_id, created_at);

CREATE TABLE login_failures (
  key text NOT NULL,
  at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_failures_key ON login_failures (key, at);

CREATE TABLE invites (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  code       text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE agents (
  id               text PRIMARY KEY CHECK (id ~ '^ag_[0-9a-f]{12}$'),
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  active_prompt_id text,
  tools            text[] NOT NULL DEFAULT '{}',
  settings         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prompts (
  id         text PRIMARY KEY CHECK (id ~ '^pr_[0-9a-f]{12}$'),
  name       text NOT NULL,
  agent_id   text REFERENCES agents (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prompts_agent ON prompts (agent_id);
ALTER TABLE agents ADD CONSTRAINT agents_active_prompt
  FOREIGN KEY (active_prompt_id) REFERENCES prompts (id) ON DELETE SET NULL;

CREATE TABLE prompt_versions (
  id        text PRIMARY KEY,
  prompt_id text NOT NULL REFERENCES prompts (id) ON DELETE CASCADE,
  prompt    text NOT NULL,
  saved_at  timestamptz NOT NULL DEFAULT now(),
  seq       bigserial NOT NULL
);
CREATE INDEX prompt_versions_prompt ON prompt_versions (prompt_id, seq DESC);

CREATE TABLE routes (
  number   text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE
);

CREATE TABLE phone_numbers (
  id              text PRIMARY KEY,
  provider        text NOT NULL CHECK (provider IN ('plivo', 'exotel', 'twilio', 'sip')),
  number          text NOT NULL UNIQUE,
  label           text NOT NULL DEFAULT '',
  credentials_enc text,            -- AES-256-GCM, see utils/crypto.js; never stored in the clear
  env_backed      boolean NOT NULL DEFAULT false,
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX phone_numbers_one_default ON phone_numbers (is_default) WHERE is_default;

CREATE TABLE tags (
  id    text PRIMARY KEY,
  name  text NOT NULL,
  color text NOT NULL CHECK (color IN ('marigold', 'plum', 'orchid', 'teal', 'silver', 'rose'))
);
CREATE UNIQUE INDEX tags_name ON tags (lower(name));

CREATE TABLE contacts (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  dnc        boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_created ON contacts (created_at, id);

CREATE TABLE contact_numbers (
  id         text PRIMARY KEY,
  contact_id text NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  number     text NOT NULL,
  position   integer NOT NULL,
  UNIQUE (contact_id, number)
);
CREATE INDEX contact_numbers_number ON contact_numbers (number);

CREATE TABLE contact_tags (
  contact_id text NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  tag_id     text NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  position   integer NOT NULL,
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE contact_number_tags (
  number_id text NOT NULL REFERENCES contact_numbers (id) ON DELETE CASCADE,
  tag_id    text NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  position  integer NOT NULL,
  PRIMARY KEY (number_id, tag_id)
);

CREATE TABLE activity (
  id    text PRIMARY KEY,
  at    timestamptz NOT NULL DEFAULT now(),
  kind  text NOT NULL,
  text  text NOT NULL,
  view  text,
  ref   text,
  actor text
);
CREATE INDEX activity_at ON activity (at DESC);

-- One row per call: how it ended (Plivo, the Studio's own dial) and what its
-- transcript says (turns, who talked, a lead, the summary).
CREATE TABLE calls (
  call_id        text PRIMARY KEY CHECK (call_id ~ '^[A-Za-z0-9-]{6,64}$'),
  peer           text,
  ours           text,
  direction      text CHECK (direction IN ('inbound', 'outbound')),
  agent_id       text,
  status         text CHECK (status IN ('ringing', 'answered', 'declined', 'no_answer', 'failed')),
  cause          text,
  cost           numeric,
  started_at     timestamptz,
  ended_at       timestamptz,
  duration_secs  integer,
  turns          integer NOT NULL DEFAULT 0,
  caller_turns   integer NOT NULL DEFAULT 0,
  lead           boolean NOT NULL DEFAULT false,
  summary        text,
  has_transcript boolean NOT NULL DEFAULT false,
  request_uuid   text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_started ON calls (started_at DESC NULLS LAST);
CREATE INDEX calls_peer ON calls (peer, started_at DESC);
CREATE INDEX calls_agent ON calls (agent_id);

-- The lines of a call's transcript the Studio shows, already masked.
CREATE TABLE call_events (
  id      bigserial PRIMARY KEY,
  call_id text NOT NULL REFERENCES calls (call_id) ON DELETE CASCADE,
  at      timestamptz,
  event   text NOT NULL,
  role    text,
  text    text,
  name    text
);
CREATE INDEX call_events_call ON call_events (call_id, id);

-- Small facts about the workspace, e.g. that the .env number was seeded once
-- (so deleting it keeps it deleted).
CREATE TABLE meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
