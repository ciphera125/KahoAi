// A record of every tool made, changed, removed or undone: by Kaho Builder or by hand in the Studio.
// Append-only for the application. What a tool did on a call is in the call's own transcript
// (call_events); this is the other half, who changed the tool itself.
import { inOrg } from "../db/pool.js";
import { ValidationError } from "../utils/errors.js";

export const PAGE_SIZES = [10, 25, 50];
const ACTIONS = new Set(["built", "undone", "created", "updated", "removed"]);
const SOURCES = new Set(["builder", "studio"]);
const clean = (text, n) => String(text ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, n);
const like = (q) => `%${String(q).replace(/[\\%_]/g, "\\$&")}%`;

export async function record(orgId, { actor, role, action, source, kind = null, toolName = null, toolLabel, agentId = null, historyId = null, detail = "" }) {
  if (!ACTIONS.has(action) || !SOURCES.has(source)) throw new Error("unknown tool log action or source");
  await inOrg(orgId, (db) => db.query(
    `INSERT INTO tool_log (org_id, actor, role, action, source, kind, tool_name, tool_label, agent_id, history_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [orgId, clean(actor, 80) || "unknown", clean(role, 20) || "unknown", action, source, kind, toolName ? clean(toolName, 80) : null,
      clean(toolLabel, 120) || "tool", agentId || null, historyId, clean(detail, 300)]));
}

export async function page(orgId, { page: p, perPage, q = null, source = null, agentId = null }) {
  const size = Number(perPage ?? 10);
  if (!PAGE_SIZES.includes(size)) throw new ValidationError(`per_page must be one of ${PAGE_SIZES.join(", ")}`);
  const n = Math.max(1, Math.floor(Number(p)) || 1);
  const term = typeof q === "string" && q.trim() ? like(q.trim().slice(0, 100)) : null;
  const src = SOURCES.has(source) ? source : null;
  const agent = typeof agentId === "string" && agentId ? agentId.slice(0, 64) : null;
  const where = `org_id = $1 AND ($2::text IS NULL OR tool_label ILIKE $2 OR detail ILIKE $2 OR actor ILIKE $2)
    AND ($3::text IS NULL OR source = $3) AND ($4::text IS NULL OR agent_id = $4)`;
  return inOrg(orgId, async (db) => {
    const total = (await db.query(`SELECT count(*)::int AS n FROM tool_log WHERE ${where}`, [orgId, term, src, agent])).rows[0].n;
    const { rows } = await db.query(
      `SELECT id, at, actor, role, action, source, kind, tool_name, tool_label, agent_id, history_id, detail FROM tool_log
        WHERE ${where} ORDER BY at DESC, id DESC LIMIT $5 OFFSET $6`, [orgId, term, src, agent, size, (n - 1) * size]);
    return { total, page: n, per_page: size, entries: rows.map((r) => ({ ...r, id: Number(r.id),
      history_id: r.history_id === null ? null : Number(r.history_id), at: r.at.toISOString() })) };
  });
}
