// Invite codes: one code, one person, one role, one week.
//
// An admin chooses the role when making the code (manager, agent builder, caller or viewer; never admin, who
// is promoted from the People list once they have joined). The role is stored with the code and is the only
// thing that decides what the person gets: nothing the person sends at sign-up can change it. An organization
// may have several codes open at once, and an admin can list and cancel them. A code is deleted the moment it
// is used, so it can never work twice.
import { inOrg } from "../db/pool.js";
import { token } from "../utils/crypto.js";
import { HttpError, NotFoundError, ValidationError } from "../utils/errors.js";
import { INVITABLE } from "./permissions.js";

export const INVITE_SECS = 7 * 24 * 3600;
export const MAX_OPEN = 25;

const shape = (r) => ({ code: r.code, role: r.role, expires: r.expires_at.getTime() / 1000, made_by: r.made_by ?? null,
  created_at: r.created_at.toISOString() });

export class TooManyInvites extends HttpError {
  constructor() { super(429, `${MAX_OPEN} invite codes are open already; cancel one you no longer need, or wait for it to expire`); }
}

/** A new code for `role`. The role must be one an invite may carry. */
export async function create(orgId, role, madeBy) {
  if (typeof role !== "string" || !INVITABLE.includes(role)) throw new ValidationError(`role must be one of: ${INVITABLE.join(", ")}`);
  return inOrg(orgId, async (db) => {
    // Counted and inserted together, so a burst of requests cannot go over the limit.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`invites:${orgId}`]);
    const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM invites WHERE org_id = $1 AND expires_at > now()", [orgId]);
    if (n >= MAX_OPEN) throw new TooManyInvites();
    const { rows } = await db.query(
      `INSERT INTO invites (code, org_id, role, made_by, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
       RETURNING code, role, made_by, created_at, expires_at`, [token(12), orgId, role, String(madeBy ?? "").slice(0, 80) || null, INVITE_SECS]);
    return shape(rows[0]);
  });
}

/** The open codes, newest first. A code that has run out is not open. */
export async function list(orgId) {
  return inOrg(orgId, async (db) => {
    const { rows } = await db.query(`SELECT code, role, made_by, created_at, expires_at FROM invites
      WHERE org_id = $1 AND expires_at > now() ORDER BY created_at DESC, code`, [orgId]);
    return rows.map(shape);
  });
}

/** Cancel a code that has not been used. Only this organization's own codes can be found. */
export async function revoke(orgId, code) {
  const gone = await inOrg(orgId, (db) => db.query("DELETE FROM invites WHERE org_id = $1 AND code = $2 RETURNING role",
    [orgId, String(code ?? "").slice(0, 100)]));
  if (!gone.rowCount) throw new NotFoundError("invite code");
  return { role: gone.rows[0].role };
}

/** Use a code, inside a transaction the caller owns: it is deleted and its organization and role handed back, or null. */
export async function consume(db, code) {
  const { rows } = await db.query("DELETE FROM invites WHERE code = $1 AND expires_at > now() RETURNING org_id, role",
    [String(code ?? "").slice(0, 100)]);
  return rows[0] ?? null;
}
