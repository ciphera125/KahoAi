# Kaho AI Studio — backend

The Studio's API: Node + Express (MVC), PostgreSQL, one organization per customer
with strict tenant isolation. It replaces the old single-process `apps/voice/admin.py`.
The voice pipeline (`apps/voice`) is unchanged and still runs on its own.

## Layout (MVC)

```
src/
  config/env.js        every setting, validated once at start-up
  db/
    pool.js            connection pools; inOrg()/asSystem() scope every query
    migrate.js         applies db/migrations/*.sql once each, in order
    migrations/        001 schema, 002 organizations + row-level security
  models/              SQL only, one file per table-group; each takes org_id first
  controllers/         request -> model -> response; no SQL here
  routes/              URL -> controller, with the role each route needs
  middleware/          security (host/origin/CSRF), auth, rate limits, errors
  services/            dialer, Plivo signature + sync, live events, start-up checks
  app.js               the public app and the separate internal (voice) app
  server.js            cluster of workers, graceful shutdown, migrate on boot
tests/                 vitest + supertest against a real PostgreSQL test DB
```

## Run

```bash
cp .env.example .env            # fill SECRETS_KEY and INTERNAL_API_TOKEN (openssl rand -hex 32)
createdb kaho_studio
npm install
npm run migrate                 # also runs automatically on npm start
npm run import:legacy -- --org-name "Acme"   # one-off: data/ and logs/calls into one organization (or --org org_...)
npm start                       # public API :8020, voice-service API :8021 (127.0.0.1)
npm test                        # 144 tests
npm run lint
```

## Organizations

One account can be in several organizations (separate environments), with a role in each
(`memberships`). A session works in one at a time (`sessions.org_id`); `POST /api/orgs` makes a new
one (you own it), `POST /api/orgs/:id/switch` moves this browser to another of yours, and
`POST /api/orgs/join` joins one with its invite code. A phone number belongs to one organization.

## Bulk calls

`POST /api/bulk-calls` takes a list (up to 5,000 rows of `{name, number}`), an agent, a number to
call from and how many calls at once (1-10). `services/bulkRunner.js` runs every `BULK_TICK_MS`
(2s) in each worker, one at a time through an advisory lock: it settles calls that ended (the
voice service reports hang-ups to `/internal/v1/calls/:id`), then dials the next rows through the
same `services/calling.js` as a single call, so Do not call, the calling window, the agent's ring
time and longest call all apply. A row is never dialled twice, and nobody called in the last
`BULK_REPEAT_HOURS` (24) is called again. With the agent's calling window off, bulk calls still keep to
09:00-21:00 India time. Organizations share `BULK_MAX_CONCURRENT` equally. New numbers are added to Contacts.

## Supabase

Use the **session pooler** or the direct connection (port 5432) as `DATABASE_URL`, never the
transaction pooler (6543): migrations and the bulk runner take advisory locks and live transcripts
LISTEN, which need a real session. TLS is switched on for Supabase hosts; set `DATABASE_SSL_CA` to
Supabase's CA certificate (Project Settings > Database > SSL) so the server is verified, not just
encrypted. Migrations create the restricted role `kaho_app` themselves.

## Tenant isolation (how one team never sees another's data)

Every customer row carries `org_id`. Models filter by it, and PostgreSQL
row-level security enforces it again underneath: a query that forgets the filter
sees nothing, never another team. All customer-data access goes through
`inOrg(orgId, fn)`, a transaction that drops to the restricted role `kaho_app`
and sets `app.org_id`. `asSystem(fn)` is the few cross-org paths (sign-in, the
voice service, imports). A plain connection sees no customer rows at all.

Roles: **owner** (one per org) → **admin** → **member**. The owner sets roles and
removes anyone; admins run numbers, bulk deletes, Plivo sync, invites and remove
members; members do the daily work.

## Before production

- **DATABASE_URL** should point at a restricted role (its own login), so RLS
  applies without relying on `SET LOCAL ROLE`. The managed database (Supabase)
  provides this; keep `DB_APP_ROLE=kaho_app` only for a privileged local login.
- **SECRETS_KEY** encrypts provider credentials at rest. Losing it makes saved
  tokens unreadable; start-up refuses to run with the wrong key.
- **REDIS_URL** shares rate-limit counts across workers and servers.
- **TRUST_PROXY=true** only behind a load balancer you control (it decides the
  client address the limits use).
- Put the voice-service API (:8021) on a private network; never expose it.
