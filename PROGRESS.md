# Tools system: progress

Autonomous run started 2026-11-07. Read this first if the session resets, then carry on
from the first step that is not `done`.

**How each step is done:** failing tests first, then the code, then the full voice
(`cd apps/voice && venv/bin/pytest -q`), backend (`cd backend && npx vitest run`) and
frontend (`cd frontend && npm test`) suites plus ruff and eslint, then one commit.
The 5 `hardening.test.js` failures on the local test database are pre-existing and
expected (that database has no `anon` role); everything else must be green.

| # | Step | Status | Commit |
|---|------|--------|--------|
| 1 | Save vs Publish, with versions and rollback | done | `1e5b235` |
| 2 | "Save What the Caller Says" (capture tool) | done | `4692c42` |
| 3 | Tasks table, Tasks page, four task tools | done | `c452beb` |
| 4 | "Look Up Contact Details" tool | done | `2f1c298` |
| 5 | The `{{` picker in the prompt editor | done | `59680d3` |
| 6 | Custom API tools ("Call My API") | done | `STEP6` |
| 7 | Tool-call History tree | in progress | |
| 8 | "Test this agent", with Publish gating | todo | |

## Already done before this run (committed)

- `7c8d9a4` cloud recordings expire with `RECORDING_RETENTION_DAYS`
- `82d88d0` live transcript reads as sentences; refused-tool line; sidebar "Tools"
- `54afe13` refused tool call is answered in words and recorded (`tool_rejected`)
- `be0fe4e` a prompt cannot ask for a tool the agent does not have (`promptCheck.js`)
- `4d02d6a` docs

## Decisions I made

- **A new agent publishes version 1 as it is created.** Otherwise someone makes an agent,
  points a number at it, calls, and hears the default persona. Only later edits are drafts.
- **Rollback publishes immediately** and lands as a new version with a note naming the one
  it came from, rather than silently rewriting history. The draft follows it back, so the
  page does not show a change nobody made.
- **Publishing with nothing changed is refused.** The version list is meant to be read, and
  identical versions make it useless.
- **The override is admin-only, and is kept on the version row for good** (who, when, and
  the exact problems that were overridden), rather than in a log that ages out.
- **`published_by_name` is stored as text beside the user id**, so history still reads
  correctly after someone leaves the organization.

- **Everything on the call path reads the published version**, including the calling
  window, longest call and ring time, not only the prompt. `calling.js` and the bulk
  runner already went through `callConfig`, so they follow automatically. Four existing
  tests now publish before asserting; that is the behaviour change, not a break.
- **Migration 009 was applied to the live Supabase database** after checking no call was
  in progress. The one existing agent (Ria) became published version 1 with the same
  prompt, tools and opening line, and `draft_changed` is false, so nothing looks changed.

### Step 2

- **The questions live in the agent's `settings.capture_fields`**, not a table of their own,
  so they are drafted, published and rolled back with everything else for free.
- **The Studio decides what an answer means, not the voice service.** The tool sends the
  field and the words; Node parses the date or amount and replies with what to do. One
  implementation of "next Friday", and the model never decides what gets stored.
- **The read-back is enforced in code, as far as it can be.** For a date, amount or phone
  number the tool refuses to save until `confirmed` is true, and hands back the value for
  the agent to read out. A setting (`confirm_answers`, default on) turns it off.
- **The tool is not offered at all when an agent has no questions**, so attaching it
  before setting any up cannot misfire.
- **Idempotency key is `call_id:field_key:turn`.** Same answer twice on one turn updates
  one row; a correction on a later turn is a new row, so the change is visible.
- **A past date is refused.** It is nearly always a mishearing, and silently storing one
  is worse than asking again.
- **`variablesOf` lives in `promptCheck.js`, not `Agent.js`** — putting it in Agent.js
  made Prompt.js import Agent.js, which imports Prompt.js.

### Step 3

- **The public API is mounted at `/api/v1`, before the Studio's own `/api` chain**, with
  its own key check. A machine client sends no Origin and carries no cookies, so it
  cannot go through the browser's CSRF checks.
- **An API key is a long random string, hashed with SHA-256, shown once.** scrypt is for
  passwords, which are guessable; a 24-byte random key is not. Only an admin can make or
  revoke one.
- **`external_id` is how a push stays idempotent** (unique per organization), and the
  call tools reuse the same column with `call_id:tool:turn`.
- **The agent's task tools only ever see the contact on the call.** The model names a
  task id; a task that is not that contact's is simply not found. `get_tasks` returns id,
  title, status and due date only — nothing it could read out by mistake.
- **A week runs Monday to Sunday** and every range is worked out in India's day, not UTC.
- **A due date added on a call is set to 09:00 India time** on the day the caller named:
  a reminder is about the day, and nobody says a time out loud.
- **CSV upload is not built**, as agreed. `tasks.source` already allows `'csv'`, so it is
  a page and a parser away.
- Tests must not start fake timers before the database pool has connected, or the run
  hangs: freeze the clock immediately before the one request that reads it.

### Step 4

- **Contacts gained a `details` JSON column** rather than a table of custom fields: what
  a customer knows about a person ("age", "loan_amount", "branch") comes from their own
  system, so it is kept as sent. Capped at 50 plain values, each a string, number or
  true/false, because it is read out on a call.
- **`POST /api/v1/contacts` upserts by phone number**, so the customer's system can keep
  a contact current without knowing our ids.
- **The tool takes no arguments at all.** Who is on the call is decided by the call, so
  there is nothing for the model to get wrong, and the reply carries no internal ids.
- **The contact editor shows "What we know"** read-only: details from their system and
  every answer saved on a call.
- The tools-list error message is now built from `KNOWN_TOOLS` in the test, so adding a
  tool no longer breaks an unrelated assertion.

### Step 5

- **Variables are filled in by the Studio, before the prompt reaches the model.** The
  voice service now sends the caller's number with its call-config request; nothing about
  the variables exists on the call path, so the model cannot read one out or be talked
  into describing them.
- **An unknown variable becomes nothing, not `{{...}}`.** Hearing "Hello, curly curly
  customer name" is the worst outcome; publish already refuses a variable we cannot fill.
- **`detail.*` is accepted without being listed**, since those fields come from the
  customer's own system and differ per contact. The picker still offers the ones this
  organization actually sends, read from the contacts it has.
- **Found and fixed while doing this:** `studio_link._clean_config` builds a fixed shape,
  so the capture fields added in step 2 were being dropped before reaching a real call.
  Three tests now cover it, including a malformed field being dropped on its own rather
  than taking the whole config down.
- `variables.js` queries the latest answers itself rather than importing `CallAnswer.js`,
  which would have made Agent.js and CallAnswer.js import each other through it.

### Step 6

- **The Studio makes the request, not the voice service.** The address, the headers and
  any key stay in one process; the voice service is told only the name, what the tool is
  for and what to collect. There is nothing on the call path a caller could talk the
  model into reading out.
- **`outbound.js` refuses private addresses**, including after resolving the hostname, so
  a tool cannot be pointed at the cloud metadata service or at something else on our own
  network. https only, no redirects followed, a hard deadline, and a capped reply.
- **Retried once, and only when nothing came back** (timeout or refused connection). A
  request that was received may already have done something.
- **The template carries its own quotes** (`"order_id": "{{input.order_number}}"`), and a
  string goes in escaped without adding a pair, so what the caller said cannot change the
  shape of the body. Covered by a test.
- **The machine name is fixed once made.** A prompt and an agent's tool list both point
  at it, so renaming the label leaves the name alone.
- **Only an admin may make, edit, test or delete one**, since it carries a key and calls
  out of our network. The saved headers are kept when the form does not send them again.
- **A failure never tells the agent why**: the caller would hear it. The person setting
  the tool up sees the full answer in the Test panel, which is their own API.
- `build_tool_schemas` gained `strict`: TOOLS_ENABLED naming an unknown tool still stops
  startup, but a Studio agent listing a custom tool that has since been deleted only logs
  and carries on, rather than refusing to answer the call.

## Known limits / to revisit

- `calls.agent_version` exists from migration 009 but is not filled in yet; it is wired
  when the voice service reports the version it answered with (step 7).
