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

export async function list(orgId, { limit = 50 } = {}) {
  const n = Math.min(Math.max(1, Number(limit) || 50), 200);
  const { rows } = await inOrg(orgId, (db) =>
    db.query("SELECT id, call_id, level, source, message, at FROM error_logs WHERE org_id = $1 ORDER BY at DESC LIMIT $2", [orgId, n]));
  return { errors: rows.map((r) => ({ ...r, id: Number(r.id), at: r.at.toISOString() })) };
}
