// Keys another system uses to push data in (today: tasks).
//
// Only a hash of the key is stored, so a copy of the database holds nothing that can be
// used. The key itself is shown once, when it is made. A key is a long random string, so
// SHA-256 is the right hash here: it is not a password, there is nothing to guess.
import { asSystem, inOrg } from "../db/pool.js";
import { hexId, sha256, token } from "../utils/crypto.js";
import { NotFoundError } from "../utils/errors.js";
import { cleanText } from "../utils/text.js";

const PREFIX = "kaho_";
export const PREFIX_SHOWN = 11; // "kaho_" plus the first six characters

const shape = (k) => ({ id: k.id, name: k.name, prefix: k.prefix,
  created_at: k.created_at.toISOString(),
  last_used_at: k.last_used_at ? k.last_used_at.toISOString() : null });

/** Makes a key and hands it back once. Nothing can show it again. */
export async function create(orgId, { name }, userId = null) {
  const key = PREFIX + token(24);
  const id = `ak_${hexId()}`;
  const row = await inOrg(orgId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, orgId, cleanText(name, 60, "name", false), key.slice(0, PREFIX_SHOWN), sha256(key), userId]);
    return rows[0];
  });
  return { ...shape(row), key };
}

export async function list(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    "SELECT * FROM api_keys WHERE org_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC", [orgId]));
  return rows.map(shape);
}

export async function revoke(orgId, id) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL RETURNING name",
    [String(id), orgId]));
  if (!rows[0]) throw new NotFoundError("key");
  return rows[0];
}

/** The organization a presented key belongs to, or null. Looked up by hash, so the key
 * is never compared in the open, and a revoked key resolves to nothing. */
export async function orgFor(presented) {
  if (typeof presented !== "string" || !presented.startsWith(PREFIX)) return null;
  const { rows } = await asSystem((db) => db.query(
    "SELECT id, org_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL", [sha256(presented)]));
  if (!rows[0]) return null;
  // Best effort: knowing a key is in use is worth more than failing a request over it.
  asSystem((db) => db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [rows[0].id]))
    .catch(() => {});
  return rows[0].org_id;
}
