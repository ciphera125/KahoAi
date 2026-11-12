// Filing the platform's records in Supabase Storage, beside the call recordings but each in its own
// folder of the same private bucket:
//
//   6-audit-logs/<organization>/<year>/<month>/<day>.jsonl       who changed what
//   7-tool-logs/<organization>/<year>/<month>/<day>.jsonl        tools made or changed, and every tool call
//   8-builder-history/<organization>/<year>/<month>/<day>.jsonl  what Kaho Builder was asked
//   9-call-records/<day>_<time>_<id>.json                        one record per finished call
// (1-recordings, 2-transcripts and 3 to 5, the people, are filed by callFiles.js and archiveUsers.js.)
// Nothing here carries a person's name, phone number or e-mail: see redact.js.
//
// Storage cannot append, so a day's file is rewritten whole from the database (the record of truth)
// each pass: running it twice, or after a failure, gives the same file. Days are India's days.
// Everything filed here was already masked when it was written to the database. Never on the call
// path. A refusal from Storage is counted, shown in the Studio's Error Logs, and retried next pass.
import { systemQuery } from "../db/pool.js";
import { logger } from "../utils/logger.js";
import * as Call from "../models/Call.js";
import * as CallAnswer from "../models/CallAnswer.js";
import * as ErrorLog from "../models/ErrorLog.js";
import { redactPII } from "../models/redact.js";
import { fileStem } from "../models/transcriptText.js";
import { putText, recordingsConfigured } from "./storage.js";

export const FOLDERS = ["6-audit-logs", "7-tool-logs", "8-builder-history", "9-call-records"];
const DAY_MS = 86_400_000;
const CALLS_PER_PASS = 200;

/** A moment's calendar day in India, as 2026-11-08. */
export const istDay = (when = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(when);

const state = { lastRun: null, lastError: null, lastFiled: 0 };
export const status = () => ({ ...state });

const ROLLUPS = {
  "6-audit-logs": async (org, since) => (await systemQuery(
    "SELECT at, actor, role, action, detail, ref FROM audit_log WHERE org_id = $1 AND at >= $2 ORDER BY at, id", [org, since])).rows,
  "8-builder-history": async (org, since) => (await systemQuery(
    `SELECT id, at, agent_id, prompt, reply, outcome, kind, names, edited_from FROM builder_history
      WHERE org_id = $1 AND at >= $2 ORDER BY at, id`, [org, since])).rows
    .map((r) => ({ ...r, prompt: redactPII(r.prompt), reply: redactPII(r.reply) })),
  "7-tool-logs": async (org, since) => {
    const changes = (await systemQuery(
      `SELECT at, actor, role, action, source, kind, tool_name, tool_label, agent_id, history_id, detail FROM tool_log
        WHERE org_id = $1 AND at >= $2 ORDER BY at, id`, [org, since])).rows.map((r) => ({ type: "change", ...r }));
    const calls = (await systemQuery(
      `SELECT e.at, e.call_id, e.name, e.event, e.ok, e.secs, e.turn, e.text FROM call_events e
        WHERE e.org_id = $1 AND e.event IN ('tool', 'tool_rejected') AND e.at >= $2 ORDER BY e.at, e.id`, [org, since]))
      .rows.map((r) => ({ type: "call", at: r.at, call_id: r.call_id, tool: r.name, event: r.event, ok: r.ok, secs: r.secs, turn: r.turn, result: redactPII(r.text) }));
    return [...changes, ...calls].sort((a, b) => new Date(a.at) - new Date(b.at));
  },
};

function jsonLine(row) {
  return JSON.stringify({ ...row, at: row.at instanceof Date ? row.at.toISOString() : row.at });
}

/** One kind of record for one organization: a file per day, each rewritten whole. */
async function fileRollup(kind, org, now, days) {
  const first = istDay(new Date(now.getTime() - (days - 1) * DAY_MS)); // the whole of the oldest day, never half of it
  const rows = await ROLLUPS[kind](org, new Date(`${first}T00:00:00+05:30`));
  const byDay = new Map();
  for (const row of rows) {
    const day = istDay(new Date(row.at));
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  let filed = 0;
  let failed = 0;
  for (const [day, list] of byDay) {
    const path = `${kind}/${org}/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}.jsonl`;
    if (await putText(path, `${list.map(jsonLine).join("\n")}\n`)) filed++; else failed++;
  }
  return { filed, failed };
}

/** A finished call as one record: when, how long, how it went, what was said and which tools ran, and
 * nothing that says who the person was. Only the last four digits of their number are kept. */
async function callRecord(org, callId) {
  const meta = await Call.forFiles(org, callId);
  const { rows: [row] } = await systemQuery(
    `SELECT peer, direction, status, cause, cost, started_at, ended_at, duration_secs, summary, lead, agent_version
       FROM calls WHERE call_id = $1 AND org_id = $2`, [callId, org]);
  const names = [meta.name];
  const clean = (t) => redactPII(t, { names });
  const turns = (await Call.turns(org, callId).catch(() => [])).map((t) => ({ ...t, text: redactPII(t.text, { names, selfIntro: t.role !== "agent" }) }));
  const answers = (await CallAnswer.forCall(org, callId)).map((a) => ({ ...a, value: clean(a.value), raw_text: clean(a.raw_text) }));
  const tools = (await systemQuery(
    `SELECT at, name, event, ok, secs, turn, text FROM call_events WHERE call_id = $1 AND org_id = $2
       AND event IN ('tool', 'tool_rejected') ORDER BY id`, [callId, org])).rows
    .map((t) => ({ at: t.at?.toISOString?.() ?? null, name: t.name, event: t.event, ok: t.ok, secs: t.secs, turn: t.turn, result: clean(t.text) }));
  const { peer, ...rest } = row;
  return { record: { call_id: callId, agent: meta.agent, agent_id: meta.agentId, ...rest, summary: clean(row.summary),
    caller_number_last4: String(peer ?? "").replace(/\D/g, "").slice(-4) || null,
    started_at: row.started_at?.toISOString?.() ?? null, ended_at: row.ended_at?.toISOString?.() ?? null, turns, tools, answers },
  path: `9-call-records/${fileStem({ startedAt: meta.startedAt, callId, anonymous: true })}.json` };
}

async function fileCalls(org) {
  const { rows } = await systemQuery(
    `SELECT call_id FROM calls WHERE org_id = $1 AND ended_at IS NOT NULL AND archived_at IS NULL
      ORDER BY ended_at LIMIT ${CALLS_PER_PASS}`, [org]);
  let filed = 0;
  let failed = 0;
  for (const { call_id: id } of rows) {
    try {
      const { record, path } = await callRecord(org, id);
      if (await putText(path, JSON.stringify(record, null, 1))) {
        await systemQuery("UPDATE calls SET archive_path = $2, archived_at = now() WHERE call_id = $1", [id, path]);
        filed++;
      } else failed++;
    } catch (err) {
      failed++;
      logger.warn({ err: String(err?.message ?? err).slice(0, 200), call: id }, "could not build a call's record");
    }
  }
  return { filed, failed };
}

const reported = new Set(); // organizations already told about the current outage, so Error Logs is not flooded

/**
 * One pass over every organization. `days` is how many of India's days, counting today, are refiled.
 * Never throws; returns what it filed and what Storage refused.
 */
export async function archiveOnce({ days = 2, now = new Date() } = {}) {
  if (!recordingsConfigured()) return { filed: 0, failed: 0, skipped: true };
  let filed = 0;
  let failed = 0;
  try {
    const orgs = (await systemQuery("SELECT id FROM organizations")).rows;
    for (const { id: org } of orgs) {
      let orgFailed = 0;
      try {
        for (const kind of Object.keys(ROLLUPS)) {
          const r = await fileRollup(kind, org, now, days);
          filed += r.filed; orgFailed += r.failed;
        }
        const c = await fileCalls(org);
        filed += c.filed; orgFailed += c.failed;
      } catch (err) {
        orgFailed++;
        logger.error({ err: String(err?.message ?? err).slice(0, 200), org }, "filing records failed");
      }
      failed += orgFailed;
      if (orgFailed && !reported.has(org)) {
        reported.add(org);
        await ErrorLog.add(org, { level: "error", source: "archive",
          message: `Could not file ${orgFailed} record${orgFailed === 1 ? "" : "s"} in Storage. They are safe in the database and will be tried again.` })
          .catch(() => {});
      }
      if (!orgFailed) reported.delete(org);
    }
  } catch (err) {
    failed++;
    logger.error({ err: String(err?.message ?? err).slice(0, 200) }, "filing records failed");
  }
  state.lastRun = new Date().toISOString();
  state.lastFiled = filed;
  state.lastError = failed ? `Could not file ${failed} record${failed === 1 ? "" : "s"} in Storage; will try again` : null;
  if (failed) logger.warn({ failed, filed }, "some records could not be filed in Storage");
  return { filed, failed };
}
