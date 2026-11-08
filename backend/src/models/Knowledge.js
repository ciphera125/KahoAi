// What an agent knows beyond its prompt: documents the owner adds, searched during a call.
// Search is plain keyword overlap over short passages. It is deterministic, needs nothing but
// Postgres, and returns the words that were actually written, so the agent quotes the document
// instead of improvising.
import { inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { get as getAgent } from "./Agent.js";

export const MAX_DOCS = 30;
export const MAX_TITLE = 120;
export const MAX_CHARS = 20000;
const PASSAGE = 500;
const TOP = 3;
const STOP = new Set("a an and are as at be but by do does for from had has have how i in is it its me my of on or our so than that the their them then there these they this to us was we what when where which who why will with you your can could would should about tell please".split(" "));

// Text that is plainly an order to the agent rather than a fact about the business. A document is data
// the agent reads aloud from; orders belong in its prompt, where they are visible and versioned.
const ORDERS = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|these|the)\b[^.\n]{0,30}\b(instructions?|rules?|prompt|guidelines?|directions?)\b/i,
  /\b(reveal|show|print|repeat|leak|tell me)\b[^.\n]{0,30}\b(system prompt|your prompt|your instructions)\b/i,
  /\byou are now\b/i, /\bforget everything\b/i, /^\s*(system|assistant)\s*:/im, /\bnew instructions?\s*:/i,
];

export async function list(orgId, agentId) {
  await getAgent(orgId, agentId);
  const { rows } = await inOrg(orgId, (db) => db.query(
    "SELECT id, title, char_length(body) AS chars, created_at FROM knowledge_docs WHERE org_id = $1 AND agent_id = $2 ORDER BY created_at, id", [orgId, agentId]));
  return rows.map((r) => ({ id: r.id, title: r.title, chars: r.chars, created_at: r.created_at.toISOString() }));
}

export async function add(orgId, agentId, { title, text }) {
  await getAgent(orgId, agentId);
  title = typeof title === "string" ? title.trim() : "";
  text = typeof text === "string" ? text.replace(/\r\n/g, "\n").trim() : "";
  if (!title || title.length > MAX_TITLE) throw new ValidationError(`give the document a name of up to ${MAX_TITLE} letters`);
  if (!text) throw new ValidationError("the document is empty");
  if (ORDERS.some((re) => re.test(text))) {
    throw new ValidationError("This reads like instructions to the agent. Write facts about your business here, and put instructions in the agent's prompt.");
  }
  if (text.length > MAX_CHARS) throw new ValidationError(`a document can be at most ${MAX_CHARS} characters; split it into two`);
  return inOrg(orgId, async (db) => {
    const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM knowledge_docs WHERE org_id = $1 AND agent_id = $2", [orgId, agentId]);
    if (n >= MAX_DOCS) throw new ValidationError(`an agent can have at most ${MAX_DOCS} documents`);
    const id = `kb_${hexId()}`;
    await db.query("INSERT INTO knowledge_docs (id, org_id, agent_id, title, body) VALUES ($1, $2, $3, $4, $5)", [id, orgId, agentId, title, text]);
    return { id, title, chars: text.length };
  });
}

export async function remove(orgId, agentId, docId) {
  await getAgent(orgId, agentId);
  const done = await inOrg(orgId, (db) => db.query("DELETE FROM knowledge_docs WHERE id = $1 AND org_id = $2 AND agent_id = $3", [String(docId), orgId, agentId]));
  if (!done.rowCount) throw new NotFoundError("document");
  return { ok: true };
}

const words = (text) => (String(text).toLowerCase().match(/[\p{L}\p{N}.]+/gu) ?? []).map((w) => w.replace(/^\.+|\.+$/g, "")).filter((w) => w && !STOP.has(w));

/** Split a document at blank lines, then glue or cut so each passage is a sentence or two. */
function passages(body) {
  const out = [];
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.replace(/\s+/g, " ").trim();
    for (let i = 0; i < text.length; i += PASSAGE) out.push(text.slice(i, i + PASSAGE));
  }
  return out;
}

/** The passages of this agent's documents that best match a question, best first. */
export async function search(orgId, agentId, question) {
  const asked = [...new Set(words(typeof question === "string" ? question.slice(0, 400) : ""))];
  if (!agentId || asked.length === 0) return [];
  const { rows } = await inOrg(orgId, (db) => db.query(
    "SELECT title, body FROM knowledge_docs WHERE org_id = $1 AND agent_id = $2", [orgId, agentId]));
  const scored = [];
  for (const doc of rows) {
    for (const text of passages(doc.body)) {
      const have = new Set(words(text));
      const hits = asked.filter((w) => have.has(w) || [...have].some((h) => h.length > 3 && w.length > 3 && (h.startsWith(w) || w.startsWith(h))));
      if (hits.length) scored.push({ score: hits.length / Math.sqrt(have.size || 1) + hits.length, source: doc.title, text });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, TOP).map(({ source, text }) => ({ source, text }));
}
