// An organization's notifications: what changed, who changed it, where to see it.
// Texts are written by the Studio itself, never by a caller.
import { inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { ValidationError } from "../utils/errors.js";

export const MAX_ITEMS = 2000;
export const MAX_PAGE = 50;
const MAX_TEXT = 160;
// Every page a notification may send you to. A name that is not here is saved without a link.
const VIEWS = new Set(["dashboard", "calls", "contacts", "agents", "prompts", "numbers", "team", "errors", "leads",
  "tasks", "your-tools", "tool-calls", "tags", "settings", "bulk", "live"]);

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

const cursorOf = (r) => Buffer.from(`${r.at.toISOString()}|${r.id}`).toString("base64url");
function readCursor(raw) {
  try {
    const [at, id] = Buffer.from(String(raw), "base64url").toString("utf8").split("|");
    if (!id || Number.isNaN(Date.parse(at))) throw new Error("bad");
    return { at: new Date(at), id };
  } catch { throw new ValidationError("that place in the notifications is not valid"); }
}

/**
 * Newest first, one page at a time. `before` is the `next` of the page before it, so scrolling never
 * repeats or skips an item even when several happened in the same moment. `since` is when this person
 * last looked: anything after it is marked new.
 */
export async function page(orgId, { limit = 20, before = null, since = null } = {}) {
  const n = Math.min(Math.max(1, Number.parseInt(limit, 10) || 20), MAX_PAGE);
  const cut = before ? readCursor(before) : null;
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT id, at, kind, text, view, ref, actor FROM activity
    WHERE org_id = $1 AND ($2::timestamptz IS NULL OR (at, id) < ($2, $3))
    ORDER BY at DESC, id DESC LIMIT $4`, [orgId, cut?.at ?? null, cut?.id ?? "", n + 1]));
  const more = rows.length > n;
  const shown = rows.slice(0, n);
  const seen = since ? new Date(since).getTime() : null;
  return { items: shown.map((r) => ({ ...r, at: r.at.toISOString(), unread: seen === null || r.at.getTime() > seen })),
    next: more ? cursorOf(shown[shown.length - 1]) : null };
}

/** Newest first, a short list (the latest item, for "mark all read"). */
export async function recent(orgId, limit = 30, since = null) {
  return (await page(orgId, { limit, since })).items;
}

export async function unread(orgId, since) {
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT count(*)::int AS n FROM (SELECT at FROM activity
    WHERE org_id = $1 ORDER BY at DESC LIMIT $2) a WHERE $3::timestamptz IS NULL OR a.at > $3`, [orgId, MAX_ITEMS, since]));
  return rows[0].n;
}
