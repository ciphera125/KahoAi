import { asSystem, inOrg } from "../db/pool.js";
import { ValidationError } from "../utils/errors.js";

const LEVELS = new Set(["error", "warn"]);
const MAX_MSG = 2000;
const MAX_SRC = 40;

export async function add(orgId, { level, source, message, call_id }) {
  if (!LEVELS.has(level)) throw new ValidationError("level must be error or warn");
  const src = String(source ?? "").slice(0, MAX_SRC);
  if (!src) throw new ValidationError("source is required");
  const msg = String(message ?? "").slice(0, MAX_MSG);
  if (!msg) throw new ValidationError("message is required");
  await asSystem((db) => db.query(
    "INSERT INTO error_logs (org_id, call_id, level, source, message) VALUES ($1, $2, $3, $4, $5)",
    [orgId, call_id || null, level, src, msg]));
}

/** One list at a time: "open" (nobody has dealt with them, the default) or "acknowledged". */
export async function list(orgId, { limit = 50, status = "open" } = {}) {
  const n = Math.min(Math.max(1, Number(limit) || 50), 200);
  const done = status === "acknowledged";
  return inOrg(orgId, async (db) => {
    const { rows } = await db.query(
      `SELECT id, call_id, level, source, message, at, acknowledged_at, acknowledged_by FROM error_logs
       WHERE org_id = $1 AND (acknowledged_at IS NOT NULL) = $2 ORDER BY at DESC LIMIT $3`, [orgId, done, n]);
    const c = (await db.query(
      "SELECT count(*) FILTER (WHERE acknowledged_at IS NULL)::int AS open, count(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acknowledged FROM error_logs WHERE org_id = $1",
      [orgId])).rows[0];
    return { counts: { open: c.open, acknowledged: c.acknowledged },
      errors: rows.map((r) => ({ ...r, id: Number(r.id), at: r.at.toISOString(),
        acknowledged_at: r.acknowledged_at ? r.acknowledged_at.toISOString() : null })) };
  });
}

/** Mark errors acknowledged (or open again). Only this organization's own rows can change. */
export async function acknowledge(orgId, ids, acknowledged, by) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((x) => Number.isSafeInteger(x) && x > 0)) {
    throw new ValidationError("ids must be a list of 1 to 200 error ids");
  }
  if (typeof acknowledged !== "boolean") throw new ValidationError("acknowledged must be true or false");
  const { rowCount } = await inOrg(orgId, (db) => db.query(
    `UPDATE error_logs SET acknowledged_at = CASE WHEN $3 THEN now() END, acknowledged_by = CASE WHEN $3 THEN $4 END
     WHERE org_id = $1 AND id = ANY($2::bigint[])`, [orgId, ids, acknowledged, String(by ?? "").slice(0, 80)]));
  return rowCount;
}
