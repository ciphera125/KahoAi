// Bulk calls: runs (a list and its settings) and their items (one per row).
// Always one organization's; the runner works across them through asSystem().
import { asSystem, inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { normalizeNumber } from "../utils/phone.js";
import { cleanText } from "../utils/text.js";
import { checkNumber } from "../services/dialer.js";
import * as PhoneNumber from "./PhoneNumber.js";

export const MAX_ROWS = 5000;
export const MAX_PARALLEL = 10;
const MAX_NAME = 80;
const OPEN = ["queued", "dialling", "calling"];

const COUNTS = `json_build_object(
    'queued', count(*) FILTER (WHERE i.status IN ('queued', 'dialling')),
    'calling', count(*) FILTER (WHERE i.status = 'calling'),
    'done', count(*) FILTER (WHERE i.status = 'done'),
    'answered', count(*) FILTER (WHERE i.outcome = 'answered'),
    'skipped', count(*) FILTER (WHERE i.status = 'skipped'),
    'failed', count(*) FILTER (WHERE i.status = 'failed'),
    'total', count(*))`;
const SHOW = `SELECT r.*, a.name AS agent_name,
    (SELECT ${COUNTS} FROM bulk_items i WHERE i.run_id = r.id) AS counts
  FROM bulk_runs r LEFT JOIN agents a ON a.id = r.agent_id`;

const shape = (r) => ({ id: r.id, name: r.name, agent_id: r.agent_id, agent_name: r.agent_name, from_id: r.from_id,
  parallel: r.parallel, status: r.status, waiting: r.waiting, created_by: r.created_by,
  created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(), counts: r.counts });

const shapeItem = (i) => ({ id: Number(i.id), name: i.name, number: i.number, status: i.status, reason: i.reason,
  call_id: i.call_id, outcome: i.outcome, placed_at: i.placed_at?.toISOString() ?? null,
  finished_at: i.finished_at?.toISOString() ?? null });

/** The rows as they will be called: numbers checked, repeats skipped, each with why. */
export function prepareRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new ValidationError("add at least one person to call");
  if (rows.length > MAX_ROWS) throw new ValidationError(`at most ${MAX_ROWS} people in one bulk call`);
  const seen = new Set();
  return rows.map((row, position) => {
    const raw = String(row?.number ?? "").trim().slice(0, 40);
    let name = String(row?.name ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_NAME);
    let number;
    try {
      number = checkNumber(normalizeNumber(raw), "The number");
    } catch {
      return { position, name: name || raw || "—", number: raw || "—", status: "skipped", reason: "not a phone number" };
    }
    if (!name) name = number;
    if (seen.has(number)) return { position, name, number, status: "skipped", reason: "already in this list" };
    seen.add(number);
    return { position, name, number, status: "queued", reason: null };
  });
}

export async function create(orgId, { name, agentId, fromId, parallel, rows, createdBy }) {
  const runName = cleanText(name || `Bulk call ${new Date().toISOString().slice(0, 10)}`, MAX_NAME, "name");
  const n = Number(parallel ?? 3);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) throw new ValidationError(`calls at once must be between 1 and ${MAX_PARALLEL}`);
  const items = prepareRows(rows);
  // Checked now, not at the first dial: a number of another organization, or one that cannot call, is refused.
  const from = (await PhoneNumber.listPublic(orgId)).find((r) => r.id === String(fromId ?? ""));
  if (!from) throw new ValidationError("choose a number to call from");
  if (from.status !== "active") throw new ValidationError(`${from.number} cannot place calls yet; edit it on Numbers`);
  return inOrg(orgId, async (db) => {
    const agent = await db.query("SELECT 1 FROM agents WHERE id = $1 AND org_id = $2", [String(agentId ?? ""), orgId]);
    if (!agent.rowCount) throw new ValidationError("choose an agent that exists");
    const id = `bk_${hexId().slice(0, 12)}`;
    await db.query(`INSERT INTO bulk_runs (id, org_id, name, agent_id, from_id, parallel, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, orgId, runName, agentId, String(fromId ?? ""), n, createdBy ?? null]);
    const cols = ["position", "name", "number", "status", "reason"];
    for (let i = 0; i < items.length; i += 500) {
      const chunk = items.slice(i, i + 500);
      await db.query(`INSERT INTO bulk_items (run_id, org_id, ${cols.join(", ")})
        SELECT $1, $2, * FROM unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::text[])`,
      [id, orgId, ...cols.map((c) => chunk.map((it) => it[c]))]);
    }
    await addContacts(db, orgId, items.filter((it) => it.status === "queued"));
    return show(db, orgId, id);
  });
}

/** Everyone in the list not yet in Contacts, by the name in the file. Existing contacts are left alone. */
async function addContacts(db, orgId, items) {
  if (!items.length) return;
  const { rows } = await db.query("SELECT number FROM contact_numbers WHERE org_id = $1 AND number = ANY($2)",
    [orgId, items.map((it) => it.number)]);
  const known = new Set(rows.map((r) => r.number));
  const fresh = items.filter((it) => !known.has(it.number));
  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500).map((it) => ({ ...it, contact: hexId(), numberId: hexId() }));
    await db.query(`INSERT INTO contacts (id, name, org_id) SELECT *, $1 FROM unnest($2::text[], $3::text[])`,
      [orgId, chunk.map((c) => c.contact), chunk.map((c) => c.name)]);
    await db.query(`INSERT INTO contact_numbers (id, contact_id, number, position, org_id)
      SELECT n, c, num, 0, $1 FROM unnest($2::text[], $3::text[], $4::text[]) AS t(n, c, num)`,
    [orgId, chunk.map((c) => c.numberId), chunk.map((c) => c.contact), chunk.map((c) => c.number)]);
  }
}

async function show(db, orgId, id) {
  const { rows } = await db.query(`${SHOW} WHERE r.id = $1 AND r.org_id = $2`, [String(id ?? ""), orgId]);
  if (!rows[0]) throw new NotFoundError("bulk call");
  return shape(rows[0]);
}

export async function list(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query(`${SHOW} WHERE r.org_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [orgId]));
  return rows.map(shape);
}

export async function get(orgId, id) {
  return inOrg(orgId, async (db) => {
    const run = await show(db, orgId, id);
    const { rows } = await db.query("SELECT * FROM bulk_items WHERE run_id = $1 AND org_id = $2 ORDER BY position", [run.id, orgId]);
    return { ...run, items: rows.map(shapeItem) };
  });
}

/** pause, resume or cancel. Cancelling skips what has not been dialled; calls already on the line carry on. */
export async function act(orgId, id, action) {
  return inOrg(orgId, async (db) => {
    const run = await show(db, orgId, id);
    const allowed = { pause: ["running"], resume: ["paused"], cancel: ["running", "paused"] }[action];
    if (!allowed) throw new NotFoundError("action");
    if (!allowed.includes(run.status)) throw new ValidationError(`this bulk call is ${run.status}`);
    const status = { pause: "paused", resume: "running", cancel: "cancelled" }[action];
    await db.query("UPDATE bulk_runs SET status = $1, waiting = NULL, updated_at = now() WHERE id = $2 AND org_id = $3",
      [status, run.id, orgId]);
    if (action === "cancel") {
      await db.query(`UPDATE bulk_items SET status = 'skipped', reason = 'the bulk call was cancelled', finished_at = now()
        WHERE run_id = $1 AND org_id = $2 AND status = 'queued'`, [run.id, orgId]);
    }
    return show(db, orgId, run.id);
  });
}

// --- for the runner (across organizations) ----------------------------------------

/** Runs with work to do: dialling (running) or calls still on the line (any status). */
export async function active() {
  const { rows } = await asSystem((db) => db.query(`SELECT * FROM bulk_runs r WHERE r.status = 'running'
    OR EXISTS (SELECT 1 FROM bulk_items i WHERE i.run_id = r.id AND i.status IN ('dialling', 'calling'))
    ORDER BY r.created_at`));
  return rows;
}

/** Items whose call has ended move to done, with how it ended. Plivo's hangup
 * report (through the voice service) is the end; a transcript is proof it was answered. */
export async function settle(runId, deadlineSecs) {
  await asSystem(async (db) => {
    await db.query(`UPDATE bulk_items i SET status = 'done', finished_at = now(),
        outcome = CASE WHEN c.has_transcript THEN 'answered' ELSE coalesce(c.status, 'unknown') END
      FROM calls c WHERE i.run_id = $1 AND i.status = 'calling' AND c.call_id = i.call_id
        AND (c.status IS DISTINCT FROM 'ringing' OR c.ended_at IS NOT NULL)`, [runId]);
    // Taken for dialling by a process that then stopped: it may or may not have rung, so never again.
    await db.query(`UPDATE bulk_items SET status = 'failed', finished_at = now(),
        reason = 'The Studio stopped while dialling; this call may or may not have been placed. Check Plivo before calling again.'
      WHERE run_id = $1 AND status = 'dialling' AND placed_at < now() - interval '5 minutes'`, [runId]);
    // A call that never reports an end must not hold its slot forever.
    await db.query(`UPDATE bulk_items SET status = 'done', outcome = 'unknown', finished_at = now()
      WHERE run_id = $1 AND status = 'calling' AND placed_at < now() - make_interval(secs => $2)`, [runId, deadlineSecs]);
  });
}

/** Open calls (dialling or on the line) per organization, across its runs. */
export async function openByOrg() {
  const { rows } = await asSystem((db) => db.query(`SELECT org_id, count(*)::int AS n FROM bulk_items
    WHERE status IN ('dialling', 'calling') GROUP BY org_id`));
  return Object.fromEntries(rows.map((r) => [r.org_id, r.n]));
}

/** Whether this organization called the number, by any bulk call or by hand, within `hours`. */
export async function calledRecently(orgId, number, hours) {
  if (!hours) return false;
  const { rows } = await asSystem((db) => db.query(`SELECT EXISTS (SELECT 1 FROM calls WHERE org_id = $1 AND peer = $2
    AND started_at > now() - make_interval(hours => $3)) AS yes`, [orgId, number, hours]));
  return rows[0].yes;
}

export async function openCounts() {
  const { rows } = await asSystem((db) => db.query(`SELECT run_id, count(*)::int AS n FROM bulk_items
    WHERE status IN ('dialling', 'calling') GROUP BY run_id`));
  return Object.fromEntries(rows.map((r) => [r.run_id, r.n]));
}

/** Take up to `n` queued items for dialling, in list order. Two runners never take the same one. */
export async function claim(runId, n) {
  if (n <= 0) return [];
  const { rows } = await asSystem((db) => db.query(`UPDATE bulk_items SET status = 'dialling', placed_at = now()
    WHERE id IN (SELECT id FROM bulk_items WHERE run_id = $1 AND status = 'queued' ORDER BY position LIMIT $2 FOR UPDATE SKIP LOCKED)
    RETURNING *`, [runId, n]));
  return rows.sort((a, b) => a.position - b.position);
}

export async function mark(itemId, fields) {
  const cols = Object.keys(fields);
  await asSystem((db) => db.query(`UPDATE bulk_items SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`,
    [itemId, ...cols.map((c) => fields[c])]));
}

export async function setRun(runId, fields) {
  const cols = Object.keys(fields);
  await asSystem((db) => db.query(`UPDATE bulk_runs SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now()
    WHERE id = $1`, [runId, ...cols.map((c) => fields[c])]));
}

/** A running run with nothing left to dial or wait on is done. */
export async function finishIfDone(runId) {
  await asSystem((db) => db.query(`UPDATE bulk_runs r SET status = 'done', waiting = NULL, updated_at = now()
    WHERE r.id = $1 AND r.status = 'running'
      AND NOT EXISTS (SELECT 1 FROM bulk_items i WHERE i.run_id = r.id AND i.status = ANY($2))`, [runId, OPEN]));
}
