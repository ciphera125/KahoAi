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
// - A run keeps as many calls on the line as the person chose ("calls at once"): the moment one ends,
//   the next person is dialled at the following pass, without waiting for the others. 50 people at 7:
//   seven on the line from the first call to the last, never eight.
// - If the voice server cannot be reached, nothing was dialled: the run pauses
//   with the reason rather than failing every row. The same when Plivo itself cannot place calls
//   (no balance, wrong keys, a rate limit) and when BULK_FAIL_STREAK dials in a row are refused:
//   the rest of the list stays queued, the team is told, and Resume carries on where it stopped.
// - Only one runner works at a time (an advisory lock), however many processes run.
import { config } from "../config/env.js";
import { lockPool } from "../db/pool.js";
import * as Activity from "../models/Activity.js";
import * as Agent from "../models/Agent.js";
import * as BulkCall from "../models/BulkCall.js";
import { logger } from "../utils/logger.js";
import { OutsideWindowError, placeCall } from "./calling.js";
import { DEFAULT_MAX_SECS } from "./dialer.js";

const LOCK = 727275;
const DEADLINE_GRACE_SECS = 120;

function windowText(w, whose = "agent") {
  return `Waiting for ${whose === "organization" ? "your organization's" : "the agent's"} calling window (${w.start}\u2013${w.end}, ${w.timezone}).`;
}

/** The hours a bulk call keeps to: the agent's window, or TRAI's when the agent has none switched on. */
const bulkWindow = (agent) => (agent.call_window?.enabled ? agent.call_window : { ...Agent.DEFAULT_WINDOW, enabled: true });

/** Stop the run with the reason, and tell the team: a pause nobody sees is a campaign nobody finishes. */
async function pauseRun(run, reason) {
  await BulkCall.setRun(run.id, { status: "paused", waiting: reason });
  await Activity.add(run.org_id, "call", `The bulk call ${run.name} paused: ${reason}`,
    { view: "bulk", ref: run.id, actor: "Kaho AI" }).catch((err) => logger.warn({ err: err.message }, "could not record a notification"));
}

async function dialOne(run, item, now) {
  if (item.attempts === 0 && await BulkCall.calledRecently(run.org_id, item.number, config.BULK_REPEAT_HOURS)) {
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
      return windowText(err.window, err.whose);
    }
    if (err.stage === "preflight" || err.stage === "provider") {
      // Nothing was dialled: the voice server is down, or Plivo cannot place calls for this account.
      // It is not this person's number, so they stay queued for when it is fixed.
      await BulkCall.mark(item.id, { status: "queued", placed_at: null });
      await pauseRun(run, err.message);
      return "paused";
    }
    const dnc = /Do not call/.test(err.message);
    await BulkCall.mark(item.id, { status: dnc ? "skipped" : "failed", reason: String(err.message).slice(0, 300),
      finished_at: new Date() });
    if (err.stage === "provider_unsure") {
      // Plivo failed on its side: this one may have rung (so it is never dialled again), and the rest wait.
      await pauseRun(run, err.message);
      return "paused";
    }
    return dnc ? null : { refused: String(err.message).slice(0, 120) };
  }
}

/** How long a run's calls may stay on the line before they are given up on. */
const deadlineFor = (agent) => (agent?.max_secs ?? DEFAULT_MAX_SECS) + (agent?.ring_secs ?? 60) + DEADLINE_GRACE_SECS;

const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

/** One pass over every bulk call. Safe to call at any time; tests call it directly.
 * Its cost does not grow with the number of runs: the open calls are read once (twice if some were settled),
 * settling is one batch, and a run is written only when something about it changed. */
export async function runOnce({ now = new Date() } = {}) {
  const runs = await BulkCall.active();
  if (!runs.length) return;
  const agents = new Map();
  const agentOf = async (id) => {
    if (!id) return null;
    if (!agents.has(id)) agents.set(id, await Agent.callConfig(id));
    return agents.get(id);
  };

  let counts = await BulkCall.openCounts();
  const onTheLine = runs.filter((r) => counts[r.id] > 0);
  if (onTheLine.length) {
    await BulkCall.settleMany(await Promise.all(onTheLine.map(async (r) => ({ id: r.id, deadlineSecs: deadlineFor(await agentOf(r.agent_id)) }))));
    counts = await BulkCall.openCounts();
  }
  const orgOpen = {};
  for (const r of runs) orgOpen[r.org_id] = (orgOpen[r.org_id] ?? 0) + (counts[r.id] ?? 0);
  // The voice server's capacity is shared with calls placed by hand and inbound ones.
  let open = sum(counts) + await BulkCall.liveOutsideCalls(config.BULK_OUTSIDE_CAP);
  const dialling = new Set(runs.filter((r) => r.status === "running").map((r) => r.org_id));
  const share = Math.max(1, Math.ceil(config.BULK_MAX_CONCURRENT / Math.max(1, dialling.size)));
  const say = (run, waiting) => (waiting === (run.waiting ?? null) ? null : BulkCall.setRun(run.id, { waiting }));

  for (const run of runs) {
    if (run.status !== "running") continue;
    const agent = await agentOf(run.agent_id);
    if (!agent) {
      await BulkCall.setRun(run.id, { status: "paused", waiting: "Its agent was deleted. Cancel this bulk call." });
      continue;
    }
    const hours = bulkWindow(agent);
    if (!Agent.inCallWindow(hours, now)) {
      await say(run, agent.call_window?.enabled ? windowText(hours)
        : `Bulk calls keep to ${hours.start}–${hours.end} (${hours.timezone}); waiting for those hours.`);
      continue;
    }
    const mine = counts[run.id] ?? 0;
    // Every slot this run was given that is empty, as far as the server and the organization's share allow.
    const slots = Math.max(0, Math.min(run.parallel - mine, config.BULK_MAX_CONCURRENT - open, share - (orgOpen[run.org_id] ?? 0)));
    let waiting = slots <= 0 && mine < run.parallel ? "Waiting for other calls to finish." : null;
    const claimed = await BulkCall.claim(run.id, slots);
    let streak = 0;
    // The first call shows whether the line works (balance, keys, voice server). Only if it was placed are the
    // rest of the free slots filled together, so they take about one dial's time and a broken line costs one request.
    const dialled = new Map();
    if (claimed.length > 1) {
      dialled.set(0, await dialOne(run, claimed[0], now));
      if (dialled.get(0) === null) {
        const rest = await Promise.all(claimed.slice(1).map((it) => dialOne(run, it, now)));
        rest.forEach((o, k) => dialled.set(k + 1, o));
      }
    }
    for (const [i, item] of claimed.entries()) {
      const outcome = dialled.has(i) ? dialled.get(i) : await dialOne(run, item, now);
      const refused = typeof outcome === "object" && outcome !== null;
      streak = refused ? streak + 1 : 0;
      if (outcome === "paused" || streak >= config.BULK_FAIL_STREAK) {
        // The rest of this pass was taken but never dialled: back to waiting.
        for (const [k, rest] of claimed.entries()) if (k > i && !dialled.has(k)) await BulkCall.mark(rest.id, { status: "queued", placed_at: null });
        if (outcome !== "paused") {
          await pauseRun(run, `${streak} calls in a row were refused (${outcome.refused}). Check the list and Plivo, then resume.`);
        }
        waiting = undefined;
        break;
      }
      if (typeof outcome === "string") waiting = outcome;
      open += 1;
      orgOpen[run.org_id] = (orgOpen[run.org_id] ?? 0) + 1;
    }
    if (waiting !== undefined) await say(run, waiting);
  }
  await BulkCall.finishDone();
}

let timer = null;
let inflight = null;

/** One pass under the lock. Only one runs at a time in this process; asked again meanwhile, it
 * returns the pass already running. Several processes may call this; the advisory lock lets one work. */
export function runLockedPass(options) {
  if (inflight) return inflight;
  inflight = (async () => {
    const client = await lockPool.connect().catch(() => null);
    try {
      if (!client) return;
      const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK]);
      if (!rows[0].ok) return;
      try {
        await runOnce(options);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
      }
    } catch (err) {
      logger.error({ err: err.message }, "bulk call runner failed; trying again on the next tick");
    } finally {
      client?.release();
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Run the runner every BULK_TICK_MS in this process. */
export function startBulkRunner() {
  if (timer) return;
  timer = setInterval(() => { runLockedPass(); }, config.BULK_TICK_MS);
  timer.unref();
}

/** Stop ticking and let the pass in flight finish (for at most `waitMs`): a call already dialled
 * must be recorded as on the line, not left as one that "may or may not have been placed". */
export async function stopBulkRunner(waitMs = 10_000) {
  clearInterval(timer);
  timer = null;
  if (!inflight) return;
  let giveUp;
  const gaveUp = new Promise((resolve) => { giveUp = setTimeout(resolve, waitMs); });
  await Promise.race([inflight.catch(() => {}), gaveUp]);
  clearTimeout(giveUp);
}
