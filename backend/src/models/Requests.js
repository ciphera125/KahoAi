// What a customer asks Kaho for, and what Kaho answers. A plan change replaces an older waiting plan change from the
// same organization (only the latest wish counts); a message is kept as written. Deciding is one atomic UPDATE that
// only matches a waiting request, so two admins cannot both answer it.
import { asSystem, inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { HttpError, NotFoundError, ValidationError } from "../utils/errors.js";

export const MAX_OPEN = 20;
const STATUSES = ["open", "done", "dismissed"];
const ACTIONS = { done: "done", dismiss: "dismissed" };
const iso = (d) => (d ? new Date(d).toISOString() : null);
const clean = (v, max, what) => {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string") throw new ValidationError(`${what} must be text`);
  const t = v.replaceAll("\u0000", "").trim();
  if (t.length > max) throw new ValidationError(`${what} can be at most ${max} characters`);
  return t;
};
export const shape = (r) => ({ id: r.id, kind: r.kind, plan_id: r.plan_id, message: r.message, status: r.status, created_by: r.created_by,
  created_at: iso(r.created_at), decided_at: iso(r.decided_at), response: r.response ?? null });

/** File a request for an organization. A plan change closes the older waiting one. */
export async function create(orgId, { kind, planId = null, message = "", userName = "Someone" }) {
  const text = clean(message, 1000, "the message");
  if (kind === "message" && !text) throw new ValidationError("write what you need");
  return inOrg(orgId, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`requests:${orgId}`]);
    if (kind === "plan_change") {
      await db.query("UPDATE org_requests SET status = 'replaced', decided_at = now(), decided_by = 'replaced' WHERE org_id = $1 AND kind = 'plan_change' AND status = 'open'", [orgId]);
    }
    const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM org_requests WHERE org_id = $1 AND status = 'open'", [orgId]);
    if (n >= MAX_OPEN) throw new HttpError(429, `${MAX_OPEN} requests are waiting already; Kaho will answer them first`);
    const { rows } = await db.query(
      "INSERT INTO org_requests (id, org_id, kind, plan_id, message, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [`rq_${hexId()}`, orgId, kind, planId, text, String(userName).slice(0, 80)]);
    return shape(rows[0]);
  });
}

/** The organization's own requests, newest first. A replaced plan change is not shown: it was never decided. */
export async function listForOrg(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    "SELECT * FROM org_requests WHERE org_id = $1 AND status <> 'replaced' ORDER BY created_at DESC, id DESC LIMIT 50", [orgId]));
  return rows.map(shape);
}

/** Admin: requests across organizations, paged. */
export async function adminList({ status = "open", page = 1, perPage = 10 } = {}) {
  if (!STATUSES.includes(status)) throw new ValidationError(`status must be one of: ${STATUSES.join(", ")}`);
  const size = [10, 25, 50].includes(Number(perPage)) ? Number(perPage) : 10;
  const p = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
  const { rows: [{ n }] } = await asSystem((db) => db.query("SELECT count(*)::int AS n FROM org_requests WHERE status = $1", [status]));
  const { rows } = await asSystem((db) => db.query(
    `SELECT r.*, o.name AS org_name, np.name AS plan_name, cp.name AS current_plan_name
       FROM org_requests r JOIN organizations o ON o.id = r.org_id LEFT JOIN plans np ON np.id = r.plan_id
       LEFT JOIN subscriptions s ON s.org_id = r.org_id LEFT JOIN plans cp ON cp.id = s.plan_id
      WHERE r.status = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT $2 OFFSET $3`, [status, size, (p - 1) * size]));
  return { total: n, page: p, per_page: size, requests: rows.map((r) => ({ ...shape(r), org_id: r.org_id, org_name: r.org_name,
    plan_name: r.plan_name ?? null, current_plan_name: r.current_plan_name ?? null })) };
}

/** Admin: answer a waiting request. Returns the request and its organization. */
export async function decide(id, { action, response = "", adminEmail }) {
  if (!/^rq_[0-9a-f]{12}$/.test(String(id))) throw new NotFoundError("request");
  const status = ACTIONS[action];
  if (!status) throw new ValidationError(`action must be one of: ${Object.keys(ACTIONS).join(", ")}`);
  const text = clean(response, 500, "the answer");
  return asSystem(async (db) => {
    const { rows } = await db.query(
      "UPDATE org_requests SET status = $2, decided_at = now(), decided_by = $3, response = $4 WHERE id = $1 AND status = 'open' RETURNING *",
      [id, status, String(adminEmail ?? "").slice(0, 120), text || null]);
    if (rows[0]) return shape(rows[0]) && { ...shape(rows[0]), org_id: rows[0].org_id };
    if (!(await db.query("SELECT 1 FROM org_requests WHERE id = $1", [id])).rowCount) throw new NotFoundError("request");
    throw new ValidationError("this request has already been answered");
  });
}

/** Used when an admin puts an organization on a plan: a waiting plan change for that plan is done. */
export async function closePlanChange(db, orgId, planId, adminEmail) {
  await db.query(`UPDATE org_requests SET status = 'done', decided_at = now(), decided_by = $3, response = 'Your plan was changed.'
    WHERE org_id = $1 AND kind = 'plan_change' AND status = 'open' AND plan_id = $2`, [orgId, planId, String(adminEmail ?? "").slice(0, 120)]);
}
