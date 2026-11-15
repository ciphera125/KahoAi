// Filing each organization's records in Supabase Storage, in its own bucket, as spreadsheets (CSV) only: they open
// in Excel, Numbers or Google Sheets, and every folder and column is named for what it holds.
//
//   who-changed-what/<organization>/<year>/<month>/<day>.csv         who changed what
//   agent-tool-activity/<organization>/<year>/<month>/<day>.csv      tools made or changed, and every tool call
//   kaho-builder-requests/<organization>/<year>/<month>/<day>.csv    what Kaho Builder was asked
//   call-log/<organization>/<year>/<month>/<day>.csv                 one row per finished call
//   call-answers/<organization>/<year>/<month>/<day>.csv             what was saved on calls
//   topups-and-minutes/<organization>/<year>/<month>/<day>.csv       every top-up request, decision and credit of the minute wallet
// (call-recordings and call-transcripts are filed by callFiles.js. The platform's own records, kept for
// Kaho staff, are in the separate admin bucket: archiveAdmin.js.)
// Nothing here carries a person's name, phone number or e-mail: see redact.js.
//
// Storage cannot append, so a day's file is rewritten whole from the database (the record of truth)
// each pass: running it twice, or after a failure, gives the same file. Days are India's days.
// Everything filed here was already masked when it was written to the database. Never on the call
// path. A refusal from Storage is counted, shown in the Studio's Error Logs, and retried next pass.
import { systemQuery } from "../db/pool.js";
import { logger } from "../utils/logger.js";
import { sheet, stamp } from "../utils/csv.js";
import * as Call from "../models/Call.js";
import * as CallAnswer from "../models/CallAnswer.js";
import * as ErrorLog from "../models/ErrorLog.js";
import { redactPII } from "../models/redact.js";
import { putCsv, recordingsConfigured } from "./storage.js";

/** Where each kind of record lives in the customers' bucket. */
export const FOLDERS = { recordings: "call-recordings", transcripts: "call-transcripts", changes: "who-changed-what", tools: "agent-tool-activity",
  builder: "kaho-builder-requests", calls: "call-log", answers: "call-answers", topups: "topups-and-minutes" };
/** And in the admin bucket. */
export const ADMIN_FOLDERS = { activity: "admin-activity", organizations: "organizations", requests: "customer-requests", topups: "all-topups", people: "people" };
const DAY_MS = 86_400_000;

/** A moment's calendar day in India, as 2026-11-08. */
export const istDay = (when = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(when);

const state = { lastRun: null, lastError: null, lastFiled: 0 };
const perOrg = new Map(); // each organization's own last run: one team never sees another's counts
const blank = { lastRun: null, lastError: null, lastFiled: 0 };
/** The last pass: one organization's own, or (no argument) the whole timer's, for tests and logs. */
export const status = (org) => ({ ...(org ? (perOrg.get(org) ?? blank) : state) });

const yn = (v) => (v ? "yes" : "no");
const list = (v) => (Array.isArray(v) ? v.join("; ") : (v ?? ""));

// Each kind: its folder, its columns in plain words, and the rows (each with an `at` that decides the day it is filed under).
const ROLLUPS = {
  changes: { head: ["When (IST)", "Who", "Their role", "What kind of change", "What happened", "Related item"],
    rows: async (org, since) => (await systemQuery(
      "SELECT at, actor, role, action, detail, ref FROM audit_log WHERE org_id = $1 AND at >= $2 ORDER BY at, id", [org, since])).rows,
    line: (r) => [stamp(r.at), r.actor, r.role, r.action, r.detail, r.ref] },
  builder: { head: ["When (IST)", "Agent", "What was asked", "What Kaho Builder answered", "Outcome", "Kind", "Names used", "Edited from"],
    rows: async (org, since) => (await systemQuery(
      `SELECT id, at, agent_id, prompt, reply, outcome, kind, names, edited_from FROM builder_history
        WHERE org_id = $1 AND at >= $2 ORDER BY at, id`, [org, since])).rows
      .map((r) => ({ ...r, prompt: redactPII(r.prompt), reply: redactPII(r.reply) })),
    line: (r) => [stamp(r.at), r.agent_id, r.prompt, r.reply, r.outcome, r.kind, list(r.names), r.edited_from] },
  // One row per event, each in the day it happened: a request is filed on the day it was asked for and its
  // confirmation on the day it was decided, so rewriting a day's file never loses what an earlier day held.
  // The people are ids ("kaho-staff" for an admin), and free text goes through the same redaction as the rest.
  topups: { head: ["When (IST)", "What happened", "Reference", "Minutes", "Price per minute (paise)", "Amount (paise)", "By", "Note"],
    rows: async (org, since) => {
      const events = (await systemQuery(
        `SELECT created_at AS at, 'requested' AS event, id, minutes, rate_paise, amount_paise, reference, requested_by AS by, NULL::text AS note
           FROM topups WHERE org_id = $1 AND created_at >= $2
         UNION ALL
         SELECT decided_at, CASE status WHEN 'paid' THEN 'paid and minutes added' WHEN 'cancelled' THEN 'withdrawn' ELSE status END, id, minutes, rate_paise, amount_paise, reference,
           CASE WHEN decided_by = 'requester' THEN requested_by ELSE 'kaho-staff' END, note
           FROM topups WHERE org_id = $1 AND decided_at IS NOT NULL AND decided_at >= $2`, [org, since])).rows
        .map((r) => ({ at: r.at, what: r.event === "requested" ? "requested" : r.event, ref: r.reference, minutes: r.minutes, rate: r.rate_paise, amount: Number(r.amount_paise), by: r.by, note: r.note ? redactPII(r.note) : "" }));
      const credits = (await systemQuery(
        `SELECT at, kind, minutes, note FROM minute_ledger WHERE org_id = $1 AND kind <> 'usage' AND at >= $2 ORDER BY at, id`, [org, since])).rows
        .map((r) => ({ at: r.at, what: `minutes ${r.kind === "plan" ? "from the plan" : r.kind === "topup" ? "added by a top-up" : "adjusted by Kaho"}`, ref: "", minutes: r.minutes, rate: "", amount: "", by: "", note: r.note ? redactPII(r.note) : "" }));
      return [...events, ...credits].sort((a, b) => new Date(a.at) - new Date(b.at));
    },
    line: (r) => [stamp(r.at), r.what, r.ref, r.minutes, r.rate, r.amount, r.by, r.note] },
  tools: { head: ["When (IST)", "Kind", "Who or which call", "What", "Tool", "Worked", "Seconds", "Turn", "Detail or result"],
    rows: async (org, since) => {
      const changes = (await systemQuery(
        `SELECT at, actor, role, action, source, kind, tool_name, tool_label, detail FROM tool_log
          WHERE org_id = $1 AND at >= $2 ORDER BY at, id`, [org, since])).rows
        .map((r) => ({ at: r.at, kind: "tool change", who: `${r.actor ?? ""}${r.role ? ` (${r.role})` : ""}`, what: r.action, tool: r.tool_label || r.tool_name || "", ok: "", secs: "", turn: "", detail: r.detail }));
      const calls = (await systemQuery(
        `SELECT e.at, e.call_id, e.name, e.event, e.ok, e.secs, e.turn, e.text FROM call_events e
          WHERE e.org_id = $1 AND e.event IN ('tool', 'tool_rejected') AND e.at >= $2 ORDER BY e.at, e.id`, [org, since])).rows
        .map((r) => ({ at: r.at, kind: "tool call", who: r.call_id, what: r.event === "tool_rejected" ? "refused" : "ran", tool: r.name, ok: r.ok === null ? "" : yn(r.ok), secs: r.secs ?? "", turn: r.turn ?? "", detail: redactPII(r.text) }));
      return [...changes, ...calls].sort((a, b) => new Date(a.at) - new Date(b.at));
    },
    line: (r) => [stamp(r.at), r.kind, r.who, r.what, r.tool, r.ok, r.secs, r.turn, r.detail] },
  // One row per finished call, filed under the day it ended. Nothing says who the person was: only the last four digits of their number.
  calls: { head: ["Call", "Started (IST)", "Ended (IST)", "Agent", "Direction", "Outcome", "Reason it ended", "Length (seconds)", "Number (last 4 digits)", "Summary", "Lead saved", "Cost"],
    rows: async (org, since) => {
      const { rows } = await systemQuery(
        `SELECT call_id, peer, direction, status, cause, cost, started_at, ended_at, duration_secs, summary, lead FROM calls
          WHERE org_id = $1 AND ended_at IS NOT NULL AND ended_at >= $2 ORDER BY ended_at, call_id`, [org, since]);
      const out = [];
      for (const r of rows) {
        const meta = await Call.forFiles(org, r.call_id).catch(() => ({}));
        out.push({ ...r, at: r.ended_at, agent: meta.agent ?? "", summary: redactPII(r.summary ?? "", { names: [meta.name] }) });
      }
      return out;
    },
    line: (r) => [r.call_id, stamp(r.started_at), stamp(r.ended_at), r.agent, r.direction, r.status, r.cause, r.duration_secs, String(r.peer ?? "").replace(/\D/g, "").slice(-4), r.summary, yn(r.lead), r.cost] },
  answers: { head: ["Call", "Saved at (IST)", "Question", "Answer", "What the caller said"],
    rows: async (org, since) => {
      const { rows } = await systemQuery(
        `SELECT call_id FROM calls WHERE org_id = $1 AND ended_at IS NOT NULL AND ended_at >= $2 ORDER BY ended_at, call_id`, [org, since]);
      const out = [];
      for (const { call_id: id } of rows) {
        const meta = await Call.forFiles(org, id).catch(() => ({}));
        for (const a of await CallAnswer.forCall(org, id).catch(() => [])) {
          const clean = (t) => redactPII(t ?? "", { names: [meta.name] });
          out.push({ at: a.at ?? a.created_at ?? meta.startedAt, call: id, label: a.label || a.field_key, value: clean(a.value), raw: clean(a.raw_text) });
        }
      }
      return out;
    },
    line: (r) => [r.call, stamp(r.at), r.label, r.value, r.raw] },
};

/** One kind of record for one organization: a file per day, each rewritten whole. */
async function fileRollup(kind, org, now, days) {
  const spec = ROLLUPS[kind];
  const first = istDay(new Date(now.getTime() - (days - 1) * DAY_MS)); // the whole of the oldest day, never half of it
  const rows = await spec.rows(org, new Date(`${first}T00:00:00+05:30`));
  const byDay = new Map();
  for (const row of rows) {
    const day = istDay(new Date(row.at));
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  let filed = 0;
  let failed = 0;
  for (const [day, items] of byDay) {
    const path = `${FOLDERS[kind]}/${org}/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}.csv`;
    if (await putCsv(path, sheet(spec.head, items.map(spec.line)))) filed++; else failed++;
  }
  return { filed, failed };
}

const reported = new Set(); // organizations already told about the current outage, so Error Logs is not flooded

/**
 * One pass over every organization, or only `orgId` when given (an admin's on-demand run files their
 * own team and nobody else's). `days` is how many of India's days, counting today, are refiled.
 * Never throws; returns what it filed and what Storage refused.
 */
export async function archiveOnce({ days = 2, now = new Date(), orgId = null } = {}) {
  if (!recordingsConfigured()) return { filed: 0, failed: 0, skipped: true };
  let filed = 0;
  let failed = 0;
  try {
    const orgs = orgId ? [{ id: orgId }] : (await systemQuery("SELECT id FROM organizations")).rows;
    for (const { id: org } of orgs) {
      let orgFailed = 0;
      const before = filed;
      try {
        for (const kind of Object.keys(ROLLUPS)) {
          const r = await fileRollup(kind, org, now, days);
          filed += r.filed; orgFailed += r.failed;
        }
      } catch (err) {
        orgFailed++;
        logger.error({ err: String(err?.message ?? err).slice(0, 200), org }, "filing records failed");
      }
      failed += orgFailed;
      perOrg.set(org, { lastRun: new Date().toISOString(), lastFiled: filed - before,
        lastError: orgFailed ? `Could not file ${orgFailed} record${orgFailed === 1 ? "" : "s"} in Storage; will try again` : null });
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
  if (orgId) return { filed, failed }; // an on-demand run for one team leaves the timer's own record alone
  state.lastRun = new Date().toISOString();
  state.lastFiled = filed;
  state.lastError = failed ? `Could not file ${failed} record${failed === 1 ? "" : "s"} in Storage; will try again` : null;
  if (failed) logger.warn({ failed, filed }, "some records could not be filed in Storage");
  return { filed, failed };
}
