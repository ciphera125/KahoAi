// An organization's notifications: what changed, who changed it, where to see it.
// Texts are written by the Studio itself, never by a caller.
import { inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";

export const MAX_ITEMS = 200;
const MAX_TEXT = 160;
const VIEWS = new Set(["dashboard", "calls", "contacts", "agents", "prompts", "numbers", "team"]);

export async function add(orgId, kind, text, { view = null, ref = null, actor = null } = {}) {
  await inOrg(orgId, async (db) => {
    await db.query("INSERT INTO activity (id, org_id, kind, text, view, ref, actor) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      hexId(), orgId, String(kind).slice(0, 20), String(text).split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_TEXT),
      VIEWS.has(view) ? view : null, ref ? String(ref).slice(0, 80) : null, actor ? String(actor).slice(0, 80) : null]);
    if (Math.random() < 0.05) {
      await db.query(`DELETE FROM activity WHERE org_id = $1 AND id IN (SELECT id FROM activity WHERE org_id = $1
        ORDER BY at DESC OFFSET $2)`, [orgId, MAX_ITEMS]);
    }
  });
}

export async function recent(orgId, limit = 30) {
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT id, at, kind, text, view, ref, actor FROM activity
    WHERE org_id = $1 ORDER BY at DESC LIMIT $2`, [orgId, Math.min(limit, MAX_ITEMS)]));
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}

export async function unread(orgId, since) {
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT count(*)::int AS n FROM (SELECT at FROM activity
    WHERE org_id = $1 ORDER BY at DESC LIMIT $2) a WHERE $3::timestamptz IS NULL OR a.at > $3`, [orgId, MAX_ITEMS, since]));
  return rows[0].n;
}
