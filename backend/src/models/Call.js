// Calls: how each one ended and what its transcript says.
import { asSystem, inOrg } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { blankDigits, maskSensitive } from "../utils/masking.js";
import { AGENT_ID, CALL_ID, normalizeNumber } from "../utils/phone.js";

export const STATUSES = ["ringing", "answered", "declined", "no_answer", "failed"];

/** Outcome fields, cleaned like the Python Studio's call_outcomes._clean:
 * anything malformed is dropped rather than stored. */
export function cleanOutcome(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "status") out.status = STATUSES.includes(value) ? value : "failed";
    else if (key === "peer" || key === "ours") {
      try { out[key] = normalizeNumber(String(value)); } catch { /* dropped */ }
    } else if (key === "direction") out.direction = String(value).toLowerCase().startsWith("in") ? "inbound" : "outbound";
    else if (key === "duration_secs" || key === "cost") {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = key === "cost" ? Math.round(n * 10000) / 10000 : Math.round(n);
    } else if (key === "request_uuid") { if (CALL_ID.test(String(value))) out.request_uuid = String(value); }
    else if (key === "agent_id") { if (AGENT_ID.test(String(value))) out.agent_id = String(value); }
    else if (key === "cause") out.cause = String(value).slice(0, 80);
    else if (key === "at") {
      const d = new Date(String(value));
      if (!Number.isNaN(d.getTime())) out.started_at = d.toISOString();
    }
  }
  return out;
}

/** Which organization a call belongs to: the one that placed it, else its
 * agent's, else the one that owns the number it was on. Null if none match;
 * such a call is shown to no one. */
async function resolveOrg(db, clean, orgId) {
  if (orgId) return orgId;
  if (clean.agent_id) {
    const a = (await db.query("SELECT org_id FROM agents WHERE id = $1", [clean.agent_id])).rows[0];
    if (a) return a.org_id;
  }
  if (clean.ours) {
    const n = (await db.query("SELECT org_id FROM phone_numbers WHERE number = $1", [clean.ours])).rows[0];
    if (n) return n.org_id;
  }
  return null;
}

/** Merge an outcome into the call, field by field: the latest line wins. A call
 * never moves from one organization to another once it has one. */
export async function recordOutcome(callId, fields, { orgId = null } = {}) {
  if (typeof callId !== "string" || !CALL_ID.test(callId)) throw new ValidationError("not a call id");
  const clean = cleanOutcome(fields);
  await asSystem(async (db) => {
    const org = await resolveOrg(db, clean, orgId);
    const existing = (await db.query("SELECT org_id FROM calls WHERE call_id = $1 FOR UPDATE", [callId])).rows[0];
    if (existing?.org_id && org && existing.org_id !== org) return; // never cross organizations
    if (existing?.org_id && clean.agent_id) {
      const owner = (await db.query("SELECT org_id FROM agents WHERE id = $1", [clean.agent_id])).rows[0];
      if (owner?.org_id !== existing.org_id) delete clean.agent_id;
    }
    const cols = Object.keys(clean);
    const sets = cols.map((c, i) => (c === "started_at" ? `started_at = coalesce(calls.started_at, $${i + 3})` : `${c} = $${i + 3}`));
    await db.query(`INSERT INTO calls (call_id, org_id${cols.map((c) => `, ${c}`).join("")})
      VALUES ($1, $2${cols.map((_, i) => `, $${i + 3}`).join("")})
      ON CONFLICT (call_id) DO UPDATE SET ${[...sets, "org_id = coalesce(calls.org_id, $2)", "updated_at = now()"].join(", ")}`,
    [callId, org, ...cols.map((c) => clean[c])]);
    await db.query("UPDATE call_events e SET org_id = c.org_id FROM calls c WHERE c.call_id = $1 AND e.call_id = c.call_id AND e.org_id IS NULL", [callId]);
  });
}

export async function countsByAgent(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    "SELECT agent_id, count(*)::int AS n FROM calls WHERE org_id = $1 AND agent_id IS NOT NULL GROUP BY agent_id", [orgId]));
  return Object.fromEntries(rows.map((r) => [r.agent_id, r.n]));
}

// A call's status as the Studio shows it: a transcript is proof it was picked
// up, and "ringing" with no outcome after 15 minutes is unknown.
export const STATUS_SQL = `CASE WHEN has_transcript THEN 'answered'
  WHEN status = 'ringing' AND started_at < now() - interval '15 minutes' THEN 'unknown'
  ELSE coalesce(status, 'failed') END`;
// Successful: picked up and the person really talked, at least two turns of
// their own, or their details saved.
export const SUCCESS_MIN_CALLER_TURNS = 2;
export const SUCCESS_SQL = `((${STATUS_SQL}) = 'answered' AND (caller_turns >= ${SUCCESS_MIN_CALLER_TURNS} OR lead))`;

// --- what the voice service reports -------------------------------------------


export const MAX_BATCH = 500;
const SHOWN = new Set(["call_start", "recording_notice_played", "live", "turn", "tool", "filler_spoken", "call_failed", "call_end"]);

const when = (raw) => {
  const d = raw ? new Date(String(raw)) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

function leadSaved(e) {
  if (e.name !== "capture_lead") return false;
  if (typeof e.ok === "boolean") return e.ok;
  try { return !("error" in (JSON.parse(e.text || "{}").result ?? {})); } catch { return false; }
}

/** Transcript lines for one call, in order. Every text is masked here, whatever
 * the sender did, because this is a store of call content. */
export async function ingest(callId, events) {
  if (typeof callId !== "string" || !CALL_ID.test(callId)) throw new ValidationError("not a call id");
  if (!Array.isArray(events)) throw new ValidationError("events must be a list");
  if (events.length > MAX_BATCH) throw new ValidationError(`at most ${MAX_BATCH} events at a time`);
  await asSystem(async (db) => {
    await db.query("INSERT INTO calls (call_id) VALUES ($1) ON CONFLICT DO NOTHING", [callId]);
    const { rows: [call] } = await db.query("SELECT * FROM calls WHERE call_id = $1 FOR UPDATE", [callId]);
    for (const e of events) {
      if (!e || typeof e !== "object") continue;
      const event = String(e.event ?? "");
      const at = when(e.at);
      let role = null, text = null, name = null;
      if (event === "call_start") { call.started_at = at; call.has_transcript = true; }
      else if (event === "call_party") {
        try { call.peer = normalizeNumber(String(e.number ?? "")); } catch { /* left as it was */ }
        if (e.direction) call.direction = String(e.direction).toLowerCase().startsWith("in") ? "inbound" : "outbound";
      } else if (event === "turn") {
        role = e.role === "user" ? "user" : "assistant";
        text = maskSensitive(String(e.text ?? "").slice(0, 4000));
        call.turns += 1;
        if (role === "user") call.caller_turns += 1;
        call.has_transcript = true;
      } else if (event === "live") {
        role = ["assistant", "agent"].includes(e.role) ? "agent" : "caller";
        text = maskSensitive(blankDigits(String(e.text ?? "").slice(0, 2000)));
      } else if (event === "tool") {
        name = String(e.name ?? "").slice(0, 40);
        call.lead = call.lead || leadSaved(e);
      } else if (event === "call_end") { call.ended_at = at; }
      else if (event === "summary") { call.summary = maskSensitive(String(e.summary ?? "").slice(0, 2000)); }
      if (SHOWN.has(event)) {
        call.has_transcript = true;
        await db.query("INSERT INTO call_events (call_id, at, event, role, text, name, org_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [callId, at, event, role, text, name, call.org_id]);
      }
    }
    const duration = call.started_at && call.ended_at
      ? Math.round((new Date(call.ended_at) - new Date(call.started_at)) / 1000) : call.duration_secs;
    await db.query(`UPDATE calls SET started_at = $2, ended_at = $3, peer = $4, direction = $5, turns = $6,
        caller_turns = $7, lead = $8, summary = $9, has_transcript = $10, duration_secs = $11, updated_at = now()
      WHERE call_id = $1`, [callId, call.started_at, call.ended_at, call.peer, call.direction, call.turns,
      call.caller_turns, call.lead, call.summary, call.has_transcript, duration]);
    await db.query("SELECT pg_notify('call_events', $1)", [callId]); // delivered on commit
  });
}

// --- what the Studio shows -----------------------------------------------------

export const PAGE_SIZES = [10, 20, 25, 50];

const FIELDS = `call_id, peer, direction, started_at, duration_secs, turns, summary, caller_turns, lead, has_transcript,
  ${STATUS_SQL} AS status, cause, cost, agent_id, ${SUCCESS_SQL} AS successful`;

const shape = (c) => ({ ...c, started_at: c.started_at ? new Date(c.started_at).toISOString() : null });

export function checkPage(page, perPage) {
  const size = Number(perPage ?? 10);
  if (!PAGE_SIZES.includes(size)) throw new ValidationError(`per_page must be one of ${PAGE_SIZES.join(", ")}`);
  return { page: Math.max(1, Math.floor(Number(page)) || 1), perPage: size };
}

/** One page of the organization's calls, newest first; only with `peers` if given. */
export async function page(orgId, { page: p, perPage, peers = null }) {
  const { page: n, perPage: size } = checkPage(p, perPage);
  const where = `WHERE org_id = $1${peers ? " AND peer = ANY($2)" : ""}`;
  const params = [orgId, ...(peers ? [peers] : [])];
  return inOrg(orgId, async (db) => {
    const list = await db.query(`SELECT ${FIELDS} FROM calls ${where} ORDER BY started_at DESC NULLS LAST, call_id
      LIMIT ${size} OFFSET ${(n - 1) * size}`, params);
    const total = await db.query(`SELECT count(*)::int AS n FROM calls ${where}`, params);
    return { total: total.rows[0].n, page: n, per_page: size, calls: list.rows.map(shape) };
  });
}

/** Calls currently in progress (ringing or on the line in the last 2 minutes). */
export async function activeCalls(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT ${FIELDS} FROM calls
    WHERE org_id = $1 AND (status = 'ringing' OR (status = 'answered' AND ended_at IS NULL))
      AND started_at > now() - interval '2 hours'
    ORDER BY started_at DESC LIMIT 50`, [orgId]));
  return rows.map(shape);
}

/** Whether the organization has this call (for the live view). */
export async function owns(orgId, callId) {
  if (!CALL_ID.test(String(callId))) return false;
  return (await inOrg(orgId, (db) => db.query("SELECT 1 FROM calls WHERE call_id = $1 AND org_id = $2", [callId, orgId]))).rowCount > 0;
}

export async function turns(orgId, callId) {
  if (!CALL_ID.test(String(callId))) throw new NotFoundError("call");
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT c.has_transcript, e.at, e.role, e.text FROM calls c
    LEFT JOIN call_events e ON e.call_id = c.call_id AND e.event = 'turn' AND e.org_id = c.org_id
    WHERE c.call_id = $1 AND c.org_id = $2 ORDER BY e.id`, [callId, orgId]));
  if (!rows.length || !rows[0].has_transcript) throw new NotFoundError("call");
  return rows.filter((r) => r.at).map((r) => ({ at: r.at.toISOString(), role: r.role === "assistant" ? "agent" : "caller", text: r.text ?? "" }));
}

/** Tool calls across all calls, newest first. */
export async function toolCalls(orgId, { limit = 50 } = {}) {
  const n = Math.min(Math.max(1, Number(limit) || 50), 200);
  const { rows } = await inOrg(orgId, (db) => db.query(
    `SELECT e.id, e.call_id, e.at, e.name, c.peer, c.agent_id FROM call_events e
     JOIN calls c ON c.call_id = e.call_id AND c.org_id = e.org_id
     WHERE e.event = 'tool' AND e.org_id = $1 ORDER BY e.id DESC LIMIT $2`, [orgId, n]));
  return rows.map((r) => ({ id: Number(r.id), call_id: r.call_id, at: r.at?.toISOString() ?? null,
    tool: r.name, peer: r.peer, agent_id: r.agent_id }));
}

/** Transcript lines after `afterId` that the live view shows; tool lines carry only the tool's name. */
export async function shownEvents(orgId, callId, afterId, limit = 500) {
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT id, event, role, text, name FROM call_events
    WHERE call_id = $1 AND org_id = $4 AND id > $2 ORDER BY id LIMIT $3`, [callId, afterId, limit, orgId]));
  return rows.map((r) => {
    const out = { event: r.event };
    if (r.event === "tool") out.name = r.name;
    if (r.event === "live" || r.event === "turn") {
      out.role = ["assistant", "agent"].includes(r.role) ? "agent" : "caller";
      out.text = r.text ?? "";
    }
    return { id: Number(r.id), shown: out };
  });
}

// --- the dashboard -------------------------------------------------------------

const pct = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : 0);

export async function dashboard(orgId, days) {
  const params = [days, orgId];
  const window = `WITH w AS (SELECT c.*, (${STATUS_SQL}) AS st, ${SUCCESS_SQL} AS ok,
      (c.started_at AT TIME ZONE 'Asia/Kolkata') AS local
    FROM calls c WHERE c.org_id = $2 AND c.started_at IS NOT NULL
      AND (c.started_at AT TIME ZONE 'Asia/Kolkata')::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ($1::int - 1))`;
  const [totals, byDay, byHour, byAgent, recent] = await inOrg(orgId, async (db) => [
    await db.query(`${window} SELECT count(*)::int AS calls,
        count(*) FILTER (WHERE st = 'answered')::int AS answered, count(*) FILTER (WHERE st = 'declined')::int AS declined,
        count(*) FILTER (WHERE st = 'no_answer')::int AS no_answer, count(*) FILTER (WHERE st = 'failed')::int AS failed,
        count(*) FILTER (WHERE st IN ('ringing', 'unknown'))::int AS ringing, count(*) FILTER (WHERE ok)::int AS successful,
        count(*) FILTER (WHERE lead)::int AS leads, count(*) FILTER (WHERE direction IS DISTINCT FROM 'inbound')::int AS outbound,
        count(*) FILTER (WHERE direction = 'inbound')::int AS inbound, count(DISTINCT peer)::int AS people,
        coalesce(avg(duration_secs) FILTER (WHERE st = 'answered'), 0) AS avg_talk,
        coalesce(sum(duration_secs) FILTER (WHERE st = 'answered'), 0)::float AS sum_talk,
        coalesce(sum(cost), 0)::float AS cost FROM w`, params),
    await db.query(`${window} SELECT to_char(d, 'YYYY-MM-DD') AS date, count(w.call_id)::int AS calls,
        count(w.call_id) FILTER (WHERE w.st = 'answered')::int AS answered, count(w.call_id) FILTER (WHERE w.ok)::int AS successful
      FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - ($1::int - 1), (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') d
      LEFT JOIN w ON w.local::date = d::date GROUP BY d ORDER BY d`, params),
    await db.query(`${window} SELECT h AS hour, count(w.call_id)::int AS calls, count(w.call_id) FILTER (WHERE w.st = 'answered')::int AS answered
      FROM generate_series(0, 23) h LEFT JOIN w ON extract(hour FROM w.local) = h GROUP BY h ORDER BY h`, params),
    await db.query(`${window} SELECT w.agent_id, a.name, count(*)::int AS calls, count(*) FILTER (WHERE st = 'answered')::int AS answered,
        count(*) FILTER (WHERE ok)::int AS successful FROM w LEFT JOIN agents a ON a.id = w.agent_id AND a.org_id = w.org_id
      WHERE w.agent_id IS NOT NULL GROUP BY w.agent_id, a.name ORDER BY calls DESC, w.agent_id`, params),
    await db.query(`${window} SELECT ${FIELDS.replaceAll(STATUS_SQL, "st").replace(`${SUCCESS_SQL} AS successful`, "ok AS successful")}
      FROM w ORDER BY started_at DESC, call_id LIMIT 8`, params),
  ]);
  const t = totals.rows[0];
  const finished = t.calls - t.ringing;
  const hours = byHour.rows.map((h) => ({ ...h, answer_rate: pct(h.answered, h.calls) }));
  const best = hours.filter((h) => h.calls >= 2)
    .reduce((top, h) => (!top || h.answer_rate > top.answer_rate || (h.answer_rate === top.answer_rate && h.calls > top.calls) ? h : top), null);
  return {
    days,
    totals: { calls: t.calls, answered: t.answered, declined: t.declined, no_answer: t.no_answer, failed: t.failed,
      ringing: t.ringing, successful: t.successful, leads: t.leads, outbound: t.outbound, inbound: t.inbound, people: t.people },
    rates: { answer: pct(t.answered, finished), success: pct(t.successful, finished), conversion: pct(t.successful, t.answered) },
    talk: { avg_secs: Math.round(Number(t.avg_talk)), total_minutes: Math.round(t.sum_talk / 6) / 10 },
    cost: Math.round(t.cost * 100) / 100,
    by_day: byDay.rows, by_hour: hours,
    by_agent: byAgent.rows.map((a) => ({ agent_id: a.agent_id, name: a.name, calls: a.calls, answered: a.answered,
      successful: a.successful, success_rate: pct(a.successful, a.calls) })),
    best_hour: best,
    recent: recent.rows.map(shape),
  };
}
