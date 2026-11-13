// The permanent record of changes. Written next to every notification; read by those who manage the
// organization. Entries are text written by the Studio, never by a caller.
import { inOrg } from "../db/pool.js";
import { ValidationError } from "../utils/errors.js";

export const PAGE_SIZES = [10, 25, 50];
const clean = (text, n) => String(text ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, n);

export async function record(orgId, { actor, role, action, detail, ref = null }) {
  await inOrg(orgId, (db) => db.query("INSERT INTO audit_log (org_id, actor, role, action, detail, ref) VALUES ($1, $2, $3, $4, $5, $6)",
    [orgId, clean(actor, 80) || "unknown", clean(role, 20) || "unknown", clean(action, 20), clean(detail, 300), ref ? clean(ref, 80) : null]));
}

const like = (q) => `%${String(q).replace(/[\\%_]/g, "\\$&")}%`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A day typed as YYYY-MM-DD (India time), or null. Anything else is refused. */
function day(raw, label) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !DAY.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new ValidationError(`${label} must be a day like 2026-11-14`);
  }
  return raw;
}
// The days are India's, since that is where the people reading the log are.
const range = (a, b) => `($${a}::date IS NULL OR (at AT TIME ZONE 'Asia/Kolkata')::date >= $${a}::date) AND ($${b}::date IS NULL OR (at AT TIME ZONE 'Asia/Kolkata')::date <= $${b}::date)`;

export async function page(orgId, { page: p, perPage, q = null, from = null, to = null }) {
  const size = Number(perPage ?? 10);
  if (!PAGE_SIZES.includes(size)) throw new ValidationError(`per_page must be one of ${PAGE_SIZES.join(", ")}`);
  const n = Math.max(1, Math.floor(Number(p)) || 1);
  const term = typeof q === "string" && q.trim() ? like(q.trim().slice(0, 100)) : null;
  const f = day(from, "from"); const t = day(to, "to");
  const where = `org_id = $1 AND ($2::text IS NULL OR detail ILIKE $2 OR actor ILIKE $2 OR action ILIKE $2) AND ${range(3, 4)}`;
  return inOrg(orgId, async (db) => {
    const total = (await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE ${where}`, [orgId, term, f, t])).rows[0].n;
    const { rows } = await db.query(`SELECT id, at, actor, role, action, detail, ref FROM audit_log WHERE ${where}
      ORDER BY at DESC, id DESC LIMIT $5 OFFSET $6`, [orgId, term, f, t, size, (n - 1) * size]);
    return { total, page: n, per_page: size, entries: rows.map((r) => ({ ...r, id: Number(r.id), at: r.at.toISOString() })) };
  });
}

/** Every entry, newest first, for the spreadsheet. */
export async function all(orgId, { limit = 20000, from = null, to = null } = {}) {
  const f = day(from, "from"); const t = day(to, "to");
  const { rows } = await inOrg(orgId, (db) => db.query(
    `SELECT at, actor, role, action, detail, ref FROM audit_log WHERE org_id = $1 AND ${range(2, 3)}
     ORDER BY at DESC, id DESC LIMIT $4`, [orgId, f, t, limit]));
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}
