// Tasks: what a reminder agent rings people about.
//
// They arrive three ways — typed in the Studio, pushed in by the customer's own system,
// or added by the agent during a call — and a CSV upload is meant to join them later.
// Whichever way, the organization is decided by the server (the session, the API key, or
// the call), never by what was sent.
import { inOrg, asSystem } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { cleanText } from "../utils/text.js";
import { todayIn, isoDay, asDay } from "./answerValue.js";

export const MAX_TITLE = 200;
export const RANGES = ["today", "yesterday", "this_week", "overdue", "all"];
export const STATUSES = ["pending", "done", "all"];
const TZ = "Asia/Kolkata";
const ID = /^tk_[0-9a-f]{12}$/;

/** Start and end of a named stretch of days, as instants, read in India's day. A week
 * runs Monday to Sunday, which is how a working week is spoken about here. */
export function rangeOf(range, now = new Date(), timezone = TZ) {
  if (!range || range === "all") return null;
  const today = todayIn(now, timezone);
  const start = asDay(today);
  const weekday = (start.getUTCDay() + 6) % 7; // Monday = 0
  const spans = {
    today: [0, 1],
    yesterday: [-1, 0],
    this_week: [-weekday, 7 - weekday],
    overdue: [-3650, 0],
  };
  const span = spans[range];
  if (!span) throw new ValidationError(`range must be one of: ${RANGES.join(", ")}`);
  const dayMs = 86400000;
  // Midnight in the time zone = the start of that day, worked out from noon UTC minus
  // the offset the zone had at that moment.
  const midnight = (offsetDays) => {
    const noon = new Date(start.getTime() + offsetDays * dayMs);
    const local = isoDay({ y: noon.getUTCFullYear(), m: noon.getUTCMonth() + 1, d: noon.getUTCDate() });
    return new Date(new Date(`${local}T00:00:00Z`).getTime() - offsetMinutes(noon, timezone) * 60000);
  };
  return { from: midnight(span[0]), to: midnight(span[1]) };
}

/** How far ahead of UTC the zone is at that moment, in minutes. */
function offsetMinutes(at, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(at).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return Math.round((asUtc - at.getTime()) / 60000);
}

function dueAt(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const when = new Date(String(raw));
  if (Number.isNaN(when.getTime())) throw new ValidationError("I could not read that date and time");
  return when;
}

const shape = (t) => ({ id: t.id, title: t.title, status: t.status, source: t.source,
  contact_id: t.contact_id, contact_name: t.contact_name ?? null, external_id: t.external_id,
  due_at: t.due_at ? t.due_at.toISOString() : null,
  created_at: t.created_at.toISOString(),
  completed_at: t.completed_at ? t.completed_at.toISOString() : null });

const SHOW = `SELECT t.*, c.name AS contact_name FROM tasks t
  LEFT JOIN contacts c ON c.id = t.contact_id AND c.org_id = t.org_id`;

async function ownedContact(db, orgId, contactId) {
  if (!contactId) return null;
  const { rows } = await db.query("SELECT id FROM contacts WHERE id = $1 AND org_id = $2", [String(contactId), orgId]);
  if (!rows[0]) throw new ValidationError("that contact is not in this organization");
  return rows[0].id;
}

/** `source` is set by the caller of this function, never by the request body. */
export async function create(orgId, { title, due_at: due, contact_id: contactId, external_id: externalId } = {},
  { source = "studio" } = {}) {
  const clean = cleanText(title, MAX_TITLE, "task");
  const when = dueAt(due);
  return inOrg(orgId, async (db) => {
    const contact = await ownedContact(db, orgId, contactId);
    const id = `tk_${hexId()}`;
    const { rows } = await db.query(
      `INSERT INTO tasks (id, org_id, contact_id, title, due_at, source, external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, external_id) DO UPDATE
         SET title = EXCLUDED.title, due_at = EXCLUDED.due_at, contact_id = EXCLUDED.contact_id
       RETURNING id`,
      [id, orgId, contact, clean, when, source, externalId ? String(externalId).slice(0, 100) : null]);
    return show(db, orgId, rows[0].id);
  });
}

async function show(db, orgId, id) {
  const { rows } = await db.query(`${SHOW} WHERE t.id = $1 AND t.org_id = $2`, [String(id), orgId]);
  if (!rows[0]) throw new NotFoundError("task");
  return shape(rows[0]);
}

export const get = (orgId, id) => inOrg(orgId, (db) => show(db, orgId, id));

export async function list(orgId, { range = "all", status = "all", contactId = null, limit = 200, now = new Date() } = {}) {
  if (!STATUSES.includes(status)) throw new ValidationError(`status must be one of: ${STATUSES.join(", ")}`);
  const window = rangeOf(range, now);
  const where = ["t.org_id = $1"];
  const params = [orgId];
  if (window) {
    params.push(window.from, window.to);
    where.push(`t.due_at >= $${params.length - 1} AND t.due_at < $${params.length}`);
  }
  if (status !== "all") { params.push(status); where.push(`t.status = $${params.length}`); }
  if (contactId) { params.push(String(contactId)); where.push(`t.contact_id = $${params.length}`); }
  params.push(Math.min(Number(limit) || 200, 500));
  const { rows } = await inOrg(orgId, (db) => db.query(
    `${SHOW} WHERE ${where.join(" AND ")} ORDER BY t.due_at NULLS LAST, t.created_at LIMIT $${params.length}`, params));
  return { items: rows.map(shape) };
}

export async function update(orgId, id, { title, due_at: due, status, contact_id: contactId } = {}) {
  return inOrg(orgId, async (db) => {
    const { rows } = await db.query("SELECT * FROM tasks WHERE id = $1 AND org_id = $2 FOR UPDATE", [String(id), orgId]);
    const task = rows[0];
    if (!task) throw new NotFoundError("task");
    const next = { title: task.title, due_at: task.due_at, status: task.status, contact_id: task.contact_id };
    if (title !== undefined && title !== null) next.title = cleanText(title, MAX_TITLE, "task");
    if (due !== undefined) next.due_at = dueAt(due);
    if (contactId !== undefined) next.contact_id = await ownedContact(db, orgId, contactId);
    if (status !== undefined && status !== null) {
      if (!["pending", "done"].includes(status)) throw new ValidationError("status must be pending or done");
      next.status = status;
    }
    const completedAt = next.status === "done" ? (task.completed_at ?? new Date()) : null;
    await db.query(`UPDATE tasks SET title = $1, due_at = $2, status = $3, contact_id = $4, completed_at = $5
      WHERE id = $6 AND org_id = $7`, [next.title, next.due_at, next.status, next.contact_id, completedAt, String(id), orgId]);
    return show(db, orgId, id);
  });
}

export async function remove(orgId, id) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    "DELETE FROM tasks WHERE id = $1 AND org_id = $2 RETURNING title", [String(id), orgId]));
  if (!rows[0]) throw new NotFoundError("task");
  return rows[0];
}

// --- what the agent sees on a call -------------------------------------------
//
// Everything here is scoped to one contact: the person on the call. The model names a
// task id, and a task that is not this contact's is simply not found, so nothing said on
// a call can reach another person's list.

const forSpeaking = (t) => ({ id: t.id, title: t.title, status: t.status,
  due: t.due_at ? t.due_at.toISOString() : null });

export async function forContactOnCall(orgId, contactId, { range = "all", status = "pending", now = new Date() } = {}) {
  if (!contactId) return [];
  const { items } = await list(orgId, { range, status, contactId, limit: 20, now });
  return items.map((t) => forSpeaking({ ...t, due_at: t.due_at ? new Date(t.due_at) : null }));
}

export async function ownedByContact(orgId, contactId, taskId) {
  if (!contactId || !ID.test(String(taskId ?? ""))) return null;
  const { rows } = await asSystem((db) => db.query(
    "SELECT id FROM tasks WHERE id = $1 AND org_id = $2 AND contact_id = $3", [String(taskId), orgId, contactId]));
  return rows[0]?.id ?? null;
}
