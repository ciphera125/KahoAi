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
| 1 | Save vs Publish, with versions and rollback | done | `7af860f` |
| 2 | "Save What the Caller Says" (capture tool) | in progress | |
| 3 | Tasks table, Tasks page, four task tools | todo | |
| 4 | "Look Up Contact Details" tool | todo | |
| 5 | The `{{` picker in the prompt editor | todo | |
| 6 | Custom API tools ("Call My API") | todo | |
| 7 | Tool-call History tree | todo | |
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

## Known limits / to revisit

- `calls.agent_version` exists from migration 009 but is not filled in yet; it is wired
  when the voice service reports the version it answered with (step 7).
