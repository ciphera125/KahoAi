// Agents: a name, a description, the tools it may use, its call settings and
// the one of its prompts it uses on calls. Numbers route to an agent, which is
// what an inbound call on that number gets.
import { asSystem, inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { AGENT_ID, normalizeNumber } from "../utils/phone.js";
import { cleanText } from "../utils/text.js";
import { logger } from "../utils/logger.js";
import { insert as insertPrompt, MAX_PROMPT_CHARS, promptText } from "./Prompt.js";

export { MAX_PROMPT_CHARS };
// The tools in the voice service's tools.REGISTRY.
export const KNOWN_TOOLS = ["end_call", "capture_lead", "transfer_to_human", "call_webhook"];
export const DEFAULT_TOOLS = ["end_call", "capture_lead"];
export const MAX_NAME = 60;
export const MAX_DESCRIPTION = 300;
export const MAX_OPENING = 200;
export const MAX_MINUTES = 30;
export const RING_SECS = [15, 60];
// The calling window: calls with this agent are placed only between start and
// end, in the agent's time zone. Off by default; 09:00-21:00 India time when
// switched on, the hours TRAI allows for commercial calls.
export const DEFAULT_WINDOW = { enabled: false, start: "09:00", end: "21:00", timezone: "Asia/Kolkata" };
export const DEFAULT_SETTINGS = { opening_line: "", max_minutes: 10, ring_secs: 40, call_window: DEFAULT_WINDOW };
export const OUTSIDE_WINDOW = "This call is getting outside the call window that we had decided for this particular agent.";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function checkWindow(current, changes) {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    throw new ValidationError("the calling window must be an object");
  }
  const out = { ...DEFAULT_WINDOW, ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (key === "enabled") out.enabled = value === true;
    else if (key === "start" || key === "end") {
      if (typeof value !== "string" || !HHMM.test(value)) throw new ValidationError(`the calling window's ${key} must be a time like 09:30`);
      out[key] = value;
    } else if (key === "timezone") {
      try { new Intl.DateTimeFormat("en", { timeZone: String(value) }); } catch {
        throw new ValidationError(`'${String(value).slice(0, 40)}' is not a time zone`);
      }
      out.timezone = String(value);
    } else throw new ValidationError(`unknown calling window setting '${String(key).slice(0, 40)}'`);
  }
  if (out.start === out.end) throw new ValidationError("the calling window must start and end at different times");
  return out;
}

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Whether `now` falls inside the window, in its time zone. Overnight windows (22:00-06:00) work. */
export function inCallWindow(window, now = new Date()) {
  const w = { ...DEFAULT_WINDOW, ...window };
  if (!w.enabled) return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: w.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const t = Number(parts.find((p) => p.type === "hour").value) * 60 + Number(parts.find((p) => p.type === "minute").value);
  const start = minutes(w.start), end = minutes(w.end);
  return start < end ? t >= start && t < end : t >= start || t < end;
}
const SETTING_LABELS = { max_minutes: "Longest call (minutes)", ring_secs: "Ring for (seconds)" };

export const TOOL_CATALOG = [
  { name: "end_call", label: "End the call",
    description: "Hangs up once the person says goodbye, or says no to “anything else?”.", needs: null },
  { name: "capture_lead", label: "Save details",
    description: "Saves the person's name, number and what they need, for a follow-up.", needs: null },
  { name: "transfer_to_human", label: "Transfer to a person",
    description: "Hands the call to your team's number when the person asks for a human.", needs: "TRANSFER_NUMBER" },
  { name: "call_webhook", label: "Your system (webhook)",
    description: "Looks something up or saves it in your own system, through a webhook.", needs: "TOOL_WEBHOOK_URL" },
];

function checkSettings(current, changes) {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    throw new ValidationError("settings must be an object");
  }
  const out = { ...DEFAULT_SETTINGS, ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (key === "call_window") {
      out.call_window = checkWindow(current?.call_window, value);
    } else if (key === "opening_line") {
      out[key] = cleanText(value, MAX_OPENING, "opening line", false);
    } else if (key === "max_minutes" || key === "ring_secs") {
      const label = SETTING_LABELS[key];
      const number = typeof value === "boolean" ? NaN : Number(value);
      if (!Number.isInteger(number) || String(value).trim() === "") throw new ValidationError(`${label} must be a number`);
      const [low, high] = key === "max_minutes" ? [1, MAX_MINUTES] : RING_SECS;
      if (number < low || number > high) throw new ValidationError(`${label} must be between ${low} and ${high}`);
      out[key] = number;
    } else {
      throw new ValidationError(`unknown setting '${String(key).slice(0, 40)}'`);
    }
  }
  return out;
}

const SHOW = `SELECT a.*,
    coalesce((SELECT array_agg(p.id ORDER BY p.created_at, p.id) FROM prompts p WHERE p.agent_id = a.id AND p.org_id = a.org_id), '{}') AS prompt_ids,
    coalesce((SELECT array_agg(r.number ORDER BY r.number) FROM routes r WHERE r.agent_id = a.id AND r.org_id = a.org_id), '{}') AS numbers
  FROM agents a`;
const settingsOf = (stored) => ({ ...DEFAULT_SETTINGS, ...stored, call_window: { ...DEFAULT_WINDOW, ...stored?.call_window } });

const shape = (a) => ({ id: a.id, name: a.name, description: a.description, active_prompt_id: a.active_prompt_id,
  tools: a.tools, settings: settingsOf(a.settings), created_at: a.created_at.toISOString(),
  updated_at: a.updated_at.toISOString(), prompt_ids: a.prompt_ids, numbers: a.numbers });

async function show(db, orgId, id) {
  const { rows } = await db.query(`${SHOW} WHERE a.id = $1 AND a.org_id = $2`, [id, orgId]);
  if (!rows[0]) throw new NotFoundError("agent");
  return shape(rows[0]);
}

export async function list(orgId) {
  return (await inOrg(orgId, (db) => db.query(`${SHOW} WHERE a.org_id = $1 ORDER BY a.created_at, a.id`, [orgId]))).rows.map(shape);
}

export const get = (orgId, id) => inOrg(orgId, (db) => show(db, orgId, typeof id === "string" ? id : ""));

export async function names(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query("SELECT id, name FROM agents WHERE org_id = $1", [orgId]));
  return Object.fromEntries(rows.map((a) => [a.id, a.name]));
}

export async function create(orgId, { name, description, prompt }) {
  name = cleanText(name, MAX_NAME, "agent name");
  description = cleanText(description, MAX_DESCRIPTION, "description", false);
  const text = promptText(prompt);
  return inOrg(orgId, async (db) => {
    const id = `ag_${hexId()}`;
    await db.query("INSERT INTO agents (id, name, description, tools, settings, org_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, name, description, DEFAULT_TOOLS, DEFAULT_SETTINGS, orgId]);
    const promptId = await insertPrompt(db, orgId, { name: cleanText(`${name} prompt`, MAX_NAME + 7, "prompt name"), text, agentId: id });
    await db.query("UPDATE agents SET active_prompt_id = $1 WHERE id = $2 AND org_id = $3", [promptId, id, orgId]);
    return show(db, orgId, id);
  });
}

export async function update(orgId, id, { name, description, tools, settings, active_prompt_id: activePromptId }) {
  return inOrg(orgId, async (db) => {
    const { rows } = await db.query("SELECT * FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE", [typeof id === "string" ? id : "", orgId]);
    const agent = rows[0];
    if (!agent) throw new NotFoundError("agent");
    const next = { name: agent.name, description: agent.description, tools: agent.tools, settings: agent.settings,
      active: agent.active_prompt_id };
    if (name !== undefined && name !== null) next.name = cleanText(name, MAX_NAME, "agent name");
    if (description !== undefined && description !== null) next.description = cleanText(description, MAX_DESCRIPTION, "description", false);
    if (tools !== undefined && tools !== null) {
      if (!Array.isArray(tools) || tools.some((t) => !KNOWN_TOOLS.includes(t))) {
        throw new ValidationError(`tools must be from: ${KNOWN_TOOLS.join(", ")}`);
      }
      next.tools = KNOWN_TOOLS.filter((t) => tools.includes(t));
    }
    if (settings !== undefined && settings !== null) next.settings = checkSettings(agent.settings, settings);
    if (activePromptId !== undefined && activePromptId !== null) {
      const own = await db.query("SELECT 1 FROM prompts WHERE id = $1 AND agent_id = $2 AND org_id = $3", [String(activePromptId), id, orgId]);
      if (!own.rowCount) throw new ValidationError("the prompt in use must be one of this agent's prompts");
      next.active = activePromptId;
    }
    await db.query(`UPDATE agents SET name = $1, description = $2, tools = $3, settings = $4, active_prompt_id = $5,
      updated_at = now() WHERE id = $6 AND org_id = $7`, [next.name, next.description, next.tools, next.settings, next.active, id, orgId]);
    return show(db, orgId, id);
  });
}

/** Its prompts stay, unassigned; its numbers go back to the default persona. */
export async function remove(orgId, id) {
  const { rows } = await inOrg(orgId, (db) => db.query("DELETE FROM agents WHERE id = $1 AND org_id = $2 RETURNING name",
    [typeof id === "string" ? id : "", orgId]));
  if (!rows[0]) throw new NotFoundError("agent");
  return rows[0];
}

export async function routes(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query("SELECT number, agent_id FROM routes WHERE org_id = $1", [orgId]));
  return Object.fromEntries(rows.map((r) => [r.number, r.agent_id]));
}

/** Route one of this organization's numbers to one of its agents (null: the default persona). */
export async function routeNumber(orgId, number, agentId) {
  number = normalizeNumber(number);
  await inOrg(orgId, async (db) => {
    if (!agentId) {
      await db.query("DELETE FROM routes WHERE number = $1 AND org_id = $2", [number, orgId]);
      return;
    }
    if (!(await db.query("SELECT 1 FROM agents WHERE id = $1 AND org_id = $2", [String(agentId), orgId])).rowCount) {
      throw new NotFoundError("agent");
    }
    await db.query(`INSERT INTO routes (number, agent_id, org_id) VALUES ($1, $2, $3)
      ON CONFLICT (number) DO UPDATE SET agent_id = EXCLUDED.agent_id WHERE routes.org_id = EXCLUDED.org_id`, [number, agentId, orgId]);
  });
}

/** The agent an inbound call on `number` gets. Never throws. */
export async function agentForNumber(number) {
  try {
    const { rows } = await asSystem((db) => db.query("SELECT agent_id FROM routes WHERE number = $1", [normalizeNumber(number || "")]));
    return rows[0]?.agent_id ?? null;
  } catch {
    return null;
  }
}

/** What a call with this agent needs, or null. Never throws: it is read at the
 * start of a live call, and an id can arrive from the network. */
export async function callConfig(agentId) {
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) return null;
  try {
    const { rows } = await asSystem((db) => db.query(`SELECT a.id, a.org_id, a.name, a.tools, a.settings,
        (SELECT v.prompt FROM prompt_versions v WHERE v.prompt_id = a.active_prompt_id AND v.org_id = a.org_id
         ORDER BY v.seq DESC LIMIT 1) AS prompt
      FROM agents a WHERE a.id = $1`, [agentId]));
    const a = rows[0];
    if (!a) return null;
    const s = settingsOf(a.settings);
    return { agent_id: a.id, org_id: a.org_id, name: a.name, prompt: a.prompt ?? null,
      tools: a.tools.filter((t) => KNOWN_TOOLS.includes(t)), opening_line: s.opening_line || null,
      max_secs: s.max_minutes * 60, ring_secs: Number(s.ring_secs), call_window: s.call_window };
  } catch (err) {
    logger.error({ err: err.message }, "agent unreadable, the call uses the default persona");
    return null;
  }
}
