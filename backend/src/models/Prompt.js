// Prompts and their saved versions. A prompt belongs to at most one agent and
// keeps every saved version, newest first, up to MAX_VERSIONS.
import { inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { cleanText } from "../utils/text.js";

// Every character is re-sent to the LLM on every turn, so a long prompt costs
// time and tokens on all of them.
export const MAX_PROMPT_CHARS = 8000;
export const MAX_VERSIONS = 50;
export const MAX_PROMPT_NAME = 67;

export function promptText(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new ValidationError("the prompt is empty");
  if (text.length > MAX_PROMPT_CHARS) throw new ValidationError(`the prompt is over ${MAX_PROMPT_CHARS} characters`);
  return text;
}

const SHOW = `SELECT p.id, p.name, p.agent_id, a.name AS agent_name,
    coalesce(a.active_prompt_id = p.id, false) AS in_use,
    coalesce((SELECT v.prompt FROM prompt_versions v WHERE v.prompt_id = p.id ORDER BY v.seq DESC LIMIT 1), '') AS prompt,
    (SELECT count(*) FROM prompt_versions v WHERE v.prompt_id = p.id)::int AS version_count,
    p.created_at, p.updated_at
  FROM prompts p LEFT JOIN agents a ON a.id = p.agent_id AND a.org_id = p.org_id`;

const iso = (r) => ({ ...r, created_at: r.created_at?.toISOString(), updated_at: r.updated_at?.toISOString() });

async function show(db, orgId, id) {
  const { rows } = await db.query(`${SHOW} WHERE p.id = $1 AND p.org_id = $2`, [id, orgId]);
  if (!rows[0]) throw new NotFoundError("prompt");
  return iso(rows[0]);
}

async function lockPrompt(db, orgId, id) {
  const { rows } = await db.query("SELECT * FROM prompts WHERE id = $1 AND org_id = $2 FOR UPDATE", [typeof id === "string" ? id : "", orgId]);
  if (!rows[0]) throw new NotFoundError("prompt");
  return rows[0];
}

/** Keep an agent's prompt in use one of its own, or none if it has none. */
export async function fixActive(db, orgId, agentId) {
  if (!agentId) return;
  await db.query(
    `UPDATE agents a SET active_prompt_id = (SELECT p.id FROM prompts p WHERE p.agent_id = a.id
       ORDER BY p.updated_at DESC, p.id LIMIT 1)
     WHERE a.id = $1 AND a.org_id = $2 AND (a.active_prompt_id IS NULL OR NOT EXISTS
       (SELECT 1 FROM prompts p WHERE p.id = a.active_prompt_id AND p.agent_id = a.id))`, [agentId, orgId]);
}

async function addVersion(db, orgId, promptId, text) {
  await db.query("INSERT INTO prompt_versions (id, prompt_id, prompt, org_id) VALUES ($1, $2, $3, $4)", [`v_${hexId()}`, promptId, text, orgId]);
  await db.query(
    `DELETE FROM prompt_versions WHERE id IN (SELECT id FROM prompt_versions WHERE prompt_id = $1 AND org_id = $3
       ORDER BY seq DESC OFFSET $2)`, [promptId, MAX_VERSIONS, orgId]);
  await db.query("UPDATE prompts SET updated_at = now() WHERE id = $1 AND org_id = $2", [promptId, orgId]);
}

/** Inside a transaction: a new prompt with its first version. */
export async function insert(db, orgId, { name, text, agentId = null }) {
  const id = `pr_${hexId()}`;
  await db.query("INSERT INTO prompts (id, name, agent_id, org_id) VALUES ($1, $2, $3, $4)", [id, name, agentId, orgId]);
  await addVersion(db, orgId, id, text);
  return id;
}

export async function list(orgId) {
  return (await inOrg(orgId, (db) => db.query(`${SHOW} WHERE p.org_id = $1 ORDER BY p.updated_at DESC, p.id`, [orgId]))).rows.map(iso);
}

export const get = (orgId, id) => inOrg(orgId, (db) => show(db, orgId, typeof id === "string" ? id : ""));

export async function create(orgId, { name, text, agentId }) {
  name = cleanText(name, MAX_PROMPT_NAME, "prompt name");
  text = promptText(text);
  return inOrg(orgId, async (db) => {
    if (agentId && !(await db.query("SELECT 1 FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE", [String(agentId), orgId])).rowCount) {
      throw new NotFoundError("agent");
    }
    const id = await insert(db, orgId, { name, text, agentId: agentId || null });
    await fixActive(db, orgId, agentId);
    return show(db, orgId, id);
  });
}

export async function update(orgId, id, { name, text }) {
  if (name !== undefined && name !== null) name = cleanText(name, MAX_PROMPT_NAME, "prompt name");
  if (text !== undefined && text !== null) text = promptText(text);
  return inOrg(orgId, async (db) => {
    await lockPrompt(db, orgId, id);
    if (typeof name === "string") await db.query("UPDATE prompts SET name = $1, updated_at = now() WHERE id = $2 AND org_id = $3", [name, id, orgId]);
    if (typeof text === "string") {
      const { rows } = await db.query("SELECT prompt FROM prompt_versions WHERE prompt_id = $1 AND org_id = $2 ORDER BY seq DESC LIMIT 1", [id, orgId]);
      if (rows[0]?.prompt !== text) await addVersion(db, orgId, id, text);
    }
    await db.query("UPDATE prompts SET updated_at = now() WHERE id = $1 AND org_id = $2", [id, orgId]);
    return show(db, orgId, id);
  });
}

export async function assign(orgId, id, agentId) {
  return inOrg(orgId, async (db) => {
    const prompt = await lockPrompt(db, orgId, id);
    if (agentId && !(await db.query("SELECT 1 FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE", [String(agentId), orgId])).rowCount) {
      throw new NotFoundError("prompt or agent");
    }
    await db.query("UPDATE prompts SET agent_id = $1 WHERE id = $2 AND org_id = $3", [agentId || null, id, orgId]);
    await fixActive(db, orgId, prompt.agent_id);
    await fixActive(db, orgId, agentId);
    return show(db, orgId, id);
  });
}

export async function remove(orgId, id) {
  return inOrg(orgId, async (db) => {
    const prompt = await lockPrompt(db, orgId, id);
    await db.query("DELETE FROM prompts WHERE id = $1 AND org_id = $2", [id, orgId]);
    await fixActive(db, orgId, prompt.agent_id);
    return prompt;
  });
}

export async function versions(orgId, id) {
  await get(orgId, id);
  const { rows } = await inOrg(orgId, (db) => db.query("SELECT id, prompt, saved_at FROM prompt_versions WHERE prompt_id = $1 AND org_id = $2 ORDER BY seq DESC", [id, orgId]));
  return rows.map((v) => ({ ...v, saved_at: v.saved_at.toISOString() }));
}

export async function restoreVersion(orgId, id, versionId) {
  return inOrg(orgId, async (db) => {
    await lockPrompt(db, orgId, id).catch(() => { throw new NotFoundError("version"); });
    const { rows } = await db.query("SELECT prompt FROM prompt_versions WHERE id = $1 AND prompt_id = $2 AND org_id = $3",
      [String(versionId), id, orgId]);
    if (!rows[0]) throw new NotFoundError("version");
    await addVersion(db, orgId, id, rows[0].prompt);
    return show(db, orgId, id);
  });
}

export async function deleteVersion(orgId, id, versionId) {
  return inOrg(orgId, async (db) => {
    await lockPrompt(db, orgId, id).catch(() => { throw new NotFoundError("version"); });
    const { rows } = await db.query("SELECT id FROM prompt_versions WHERE prompt_id = $1 AND org_id = $2 ORDER BY seq DESC", [id, orgId]);
    const ids = rows.map((r) => r.id);
    if (!ids.includes(versionId)) throw new NotFoundError("version");
    if (ids[0] === versionId) throw new ValidationError("this is the version in use; restore another one first");
    await db.query("DELETE FROM prompt_versions WHERE id = $1 AND org_id = $2", [versionId, orgId]);
  });
}
