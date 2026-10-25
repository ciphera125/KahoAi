// The bulk-call runner: every few seconds, for each running bulk call, settle
// the calls that ended and dial the next rows, never more at once than the run
// allows, nor more across all runs than the voice server takes
// (BULK_MAX_CONCURRENT, its WS_MAX_CONCURRENT_CALLS).
//
// - Each row is dialled at most once (placing a call is never retried).
// - A Do not call number is skipped, not dialled.
// - Outside the agent's calling window nothing is dialled; the run waits. With
//   the agent's window switched off, bulk calls still keep to 09:00-21:00 India
//   time (TRAI's hours for commercial calls).
// - Nobody this organization called in the last BULK_REPEAT_HOURS (by any bulk
//   call or by hand) is called again; two lists with the same person ring once.
// - Organizations share BULK_MAX_CONCURRENT fairly: with N of them dialling,
//   none takes more than its 1/N share.
// - If the voice server cannot be reached, nothing was dialled: the run pauses
//   with the reason rather than failing every row.
// - Only one runner works at a time (an advisory lock), however many processes run.
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import * as Agent from "../models/Agent.js";
import * as BulkCall from "../models/BulkCall.js";
import { logger } from "../utils/logger.js";
import { OutsideWindowError, placeCall } from "./calling.js";
import { DEFAULT_MAX_SECS } from "./dialer.js";

const LOCK = 727275;
const DEADLINE_GRACE_SECS = 120;

function windowText(w) {
  return `Waiting for the agent's calling window (${w.start}–${w.end}, ${w.timezone}).`;
}

/** The hours a bulk call keeps to: the agent's window, or TRAI's when the agent has none switched on. */
const bulkWindow = (agent) => (agent.call_window?.enabled ? agent.call_window : { ...Agent.DEFAULT_WINDOW, enabled: true });

async function dialOne(run, item, now) {
  if (await BulkCall.calledRecently(run.org_id, item.number, config.BULK_REPEAT_HOURS)) {
    await BulkCall.mark(item.id, { status: "skipped", reason: `already called in the last ${config.BULK_REPEAT_HOURS} hours`,
      finished_at: new Date() });
    return null;
  }
  try {
    const placed = await placeCall(run.org_id, { fromId: run.from_id, to: item.number, agentId: run.agent_id, now });
    if (!placed.request_uuid) {
      await BulkCall.mark(item.id, { status: "done", outcome: "unknown", reason: "Plivo gave no call id", finished_at: new Date() });
    } else {
      await BulkCall.mark(item.id, { status: "calling", call_id: placed.request_uuid, placed_at: new Date() });
    }
    return null;
  } catch (err) {
    if (err instanceof OutsideWindowError) {
      await BulkCall.mark(item.id, { status: "queued", placed_at: null });
      return windowText(err.window);
    }
    if (err.stage === "preflight") {
      // Nothing was dialled: the voice server is down, not this person's number.
      await BulkCall.mark(item.id, { status: "queued", placed_at: null });
      await BulkCall.setRun(run.id, { status: "paused", waiting: err.message });
      return "paused";
    }
    const dnc = /Do not call/.test(err.message);
    await BulkCall.mark(item.id, { status: dnc ? "skipped" : "failed", reason: String(err.message).slice(0, 300),
      finished_at: new Date() });
    return null;
  }
}

/** One pass over every bulk call. Safe to call at any time; tests call it directly. */
export async function runOnce({ now = new Date() } = {}) {
  const runs = await BulkCall.active();
  let open;
  const dialling = new Set(runs.filter((r) => r.status === "running").map((r) => r.org_id));
  const share = Math.max(1, Math.ceil(config.BULK_MAX_CONCURRENT / Math.max(1, dialling.size)));
  for (const run of runs) {
    const agent = run.agent_id ? await Agent.callConfig(run.agent_id) : null;
    const deadline = (agent?.max_secs ?? DEFAULT_MAX_SECS) + (agent?.ring_secs ?? 60) + DEADLINE_GRACE_SECS;
    await BulkCall.settle(run.id, deadline);
    open = Object.values(await BulkCall.openCounts()).reduce((a, b) => a + b, 0);
    if (run.status !== "running") continue;
    if (!agent) {
      await BulkCall.setRun(run.id, { status: "paused", waiting: "Its agent was deleted. Cancel this bulk call." });
      continue;
    }
    const hours = bulkWindow(agent);
    if (!Agent.inCallWindow(hours, now)) {
      await BulkCall.setRun(run.id, { waiting: agent.call_window?.enabled ? windowText(hours)
        : `Bulk calls keep to ${hours.start}–${hours.end} (${hours.timezone}); waiting for those hours.` });
      continue;
    }
    const mine = (await BulkCall.openCounts())[run.id] ?? 0;
    const orgOpen = (await BulkCall.openByOrg())[run.org_id] ?? 0;
    const slots = Math.min(run.parallel - mine, config.BULK_MAX_CONCURRENT - open, share - orgOpen);
    let waiting = slots <= 0 && mine === 0 ? "Waiting for other calls to finish." : null;
    const claimed = await BulkCall.claim(run.id, slots);
    for (const [i, item] of claimed.entries()) {
      const outcome = await dialOne(run, item, now);
      if (outcome === "paused") {
        // The rest of this pass was taken but never dialled: back to waiting.
        for (const rest of claimed.slice(i + 1)) await BulkCall.mark(rest.id, { status: "queued", placed_at: null });
        waiting = undefined;
        break;
      }
      if (outcome) waiting = outcome;
      open += 1;
    }
    if (waiting !== undefined) await BulkCall.setRun(run.id, { waiting });
    await BulkCall.finishIfDone(run.id);
  }
}

let timer = null;
let busy = false;

/** Run the runner every BULK_TICK_MS in this process. Several processes may call
 * this; the advisory lock lets one of them work at a time. */
export function startBulkRunner() {
  if (timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    const client = await pool.connect().catch(() => null);
    try {
      if (!client) return;
      const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK]);
      if (!rows[0].ok) return;
      try {
        await runOnce();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
      }
    } catch (err) {
      logger.error({ err: err.message }, "bulk call runner failed; trying again on the next tick");
    } finally {
      client?.release();
      busy = false;
    }
  }, config.BULK_TICK_MS);
  timer.unref();
}

export function stopBulkRunner() {
  clearInterval(timer);
  timer = null;
}
