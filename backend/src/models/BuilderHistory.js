// What people asked Kaho Builder, kept so they can see it again and edit it. Append-only for the
// application: editing a prompt makes a new entry that points at the one it came from, so what was
// originally asked is never rewritten. The text is stored as typed and shown as text, never as markup.
import { inOrg } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { redactPII } from "./redact.js";

export const PAGE_SIZES = [10, 25, 50];
const OUTCOMES = new Set(["built", "asked", "failed", "refused"]);
const like = (q) => `%${String(q).replace(/[\\%_]/g, "\\$&")}%`;

/** The id of an earlier entry this one edits, or null. Someone else's entry is a 404. */
export async function checkEdit(orgId, raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (!/^\d{1,15}$/.test(String(raw))) throw new ValidationError("edited_from must be the id of an earlier prompt");
  const { rows } = await inOrg(orgId, (db) => db.query("SELECT id FROM builder_history WHERE id = $1 AND org_id = $2", [raw, orgId]));
  if (!rows[0]) throw new NotFoundError("prompt");
  return Number(rows[0].id);
}

export async function record(orgId, { agentId, actor, prompt, reply, outcome, kind = null, names = [], editedFrom = null }) {
  if (!OUTCOMES.has(outcome)) throw new Error(`unknown outcome ${outcome}`);
  const { rows } = await inOrg(orgId, (db) => db.query(
    `INSERT INTO builder_history (org_id, agent_id, actor, prompt, reply, outcome, kind, names, edited_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING id`,
    [orgId, agentId || null, String(actor ?? "unknown").slice(0, 80) || "unknown", redactPII(String(prompt ?? "").slice(0, 600)),
      redactPII(String(reply ?? "").slice(0, 2000)), outcome, kind, JSON.stringify((names ?? []).slice(0, 20).map((n) => String(n).slice(0, 80))), editedFrom]));
  return Number(rows[0].id);
}

export async function page(orgId, { page: p, perPage, q = null, agentId = null }) {
  const size = Number(perPage ?? 10);
  if (!PAGE_SIZES.includes(size)) throw new ValidationError(`per_page must be one of ${PAGE_SIZES.join(", ")}`);
  const n = Math.max(1, Math.floor(Number(p)) || 1);
  const term = typeof q === "string" && q.trim() ? like(q.trim().slice(0, 100)) : null;
  const agent = typeof agentId === "string" && agentId ? agentId.slice(0, 64) : null;
  const where = "org_id = $1 AND ($2::text IS NULL OR prompt ILIKE $2 OR reply ILIKE $2) AND ($3::text IS NULL OR agent_id = $3)";
  return inOrg(orgId, async (db) => {
    const total = (await db.query(`SELECT count(*)::int AS n FROM builder_history WHERE ${where}`, [orgId, term, agent])).rows[0].n;
    const { rows } = await db.query(
      `SELECT id, at, agent_id, actor, prompt, reply, outcome, kind, names, edited_from FROM builder_history
        WHERE ${where} ORDER BY at DESC, id DESC LIMIT $4 OFFSET $5`, [orgId, term, agent, size, (n - 1) * size]);
    return { total, page: n, per_page: size, entries: rows.map((r) => ({ ...r, id: Number(r.id),
      edited_from: r.edited_from === null ? null : Number(r.edited_from), at: r.at.toISOString() })) };
  });
}
