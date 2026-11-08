// Agents: a name, a description, the tools it may use, its call settings and
// the one of its prompts it uses on calls. Numbers route to an agent, which is
// what an inbound call on that number gets.
import { findTemplate } from "./templates.js";
import { config } from "../config/env.js";
import { asSystem, inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { DEFAULT_TOOLS, KNOWN_TOOLS } from "./toolCatalog.js";
import { KINDS as CAPTURE_KINDS } from "./answerValue.js";
import { DEFAULT_LANGUAGE, LANGUAGE_CHOICES, LANGUAGE_VALUES } from "./language.js";
import { fill as fillVariables, offered } from "./variables.js";
import { standing as testStanding } from "./AgentTest.js";
import { get as orgSettings } from "./OrgSettings.js";
import { idForNumber as contactIdForNumber } from "./Contact.js";
import { namesFor as customToolNames, forCall as customToolsForCall, labelsFor as customToolLabels } from "./CustomTool.js";
import { promptProblems, variablesOf } from "./promptCheck.js";
import { AGENT_ID, normalizeNumber } from "../utils/phone.js";
import { cleanText } from "../utils/text.js";
import { logger } from "../utils/logger.js";
import { addVersion as addPromptVersion, insert as insertPrompt, MAX_PROMPT_CHARS, promptText } from "./Prompt.js";

export { MAX_PROMPT_CHARS };
export { KNOWN_TOOLS, DEFAULT_TOOLS, TOOL_CATALOG } from "./toolCatalog.js";
export { variablesOf } from "./promptCheck.js";
// The tools in the voice service's tools.REGISTRY.
export const MAX_NAME = 60;
export const MAX_DESCRIPTION = 300;
export const MAX_OPENING = 200;
export const MAX_MINUTES = 30;
export const RING_SECS = [15, 60];
// The calling window: calls with this agent are placed only between start and
// end, in the agent's time zone. Off by default; 09:00-21:00 India time when
// switched on, the hours TRAI allows for commercial calls.
export const DEFAULT_WINDOW = { enabled: false, start: "09:00", end: "21:00", timezone: "Asia/Kolkata" };
export const MAX_CAPTURE_FIELDS = 20;
export const DEFAULT_SETTINGS = { opening_line: "", max_minutes: 10, ring_secs: 40, call_window: DEFAULT_WINDOW,
  capture_fields: [], confirm_answers: true, language: DEFAULT_LANGUAGE };

/** "Payment date" -> "payment_date". A field needs a short machine name: it is what the
 * model names when it saves an answer, and what a prompt reads as {{answer.payment_date}}. */
export function fieldKey(label) {
  return String(label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

/** The questions this agent asks and saves. Kept in settings so they are drafted and
 * published with everything else. */
export function checkCaptureFields(raw) {
  if (!Array.isArray(raw)) throw new ValidationError("the questions to save must be a list");
  if (raw.length > MAX_CAPTURE_FIELDS) throw new ValidationError(`at most ${MAX_CAPTURE_FIELDS} questions to save`);
  const out = [];
  for (const field of raw) {
    if (!field || typeof field !== "object") throw new ValidationError("each question to save must be an object");
    const label = cleanText(field.label, 60, "question label");
    const key = fieldKey(field.key || label);
    if (!key) throw new ValidationError(`'${label}' needs a short name made of letters`);
    if (!CAPTURE_KINDS.includes(field.kind)) {
      throw new ValidationError(`'${label}' must be one of: ${CAPTURE_KINDS.join(", ")}`);
    }
    const choices = Array.isArray(field.choices) ? field.choices.map((c) => cleanText(c, 60, "choice")).filter(Boolean) : [];
    if (field.kind === "choice" && choices.length < 2) {
      throw new ValidationError(`'${label}' is a choice question, so it needs at least two choices`);
    }
    if (out.some((f) => f.key === key)) throw new ValidationError(`two questions share the short name '${key}'`);
    out.push({ key, label, kind: field.kind, choices, required: Boolean(field.required),
      ask: cleanText(field.ask, 200, "example question", false) });
  }
  return out;
}
export const OUTSIDE_WINDOW = "This call is getting outside the call window that we had decided for this particular agent.";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function checkWindow(current, changes) {
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


/** Refuses a prompt an agent could not actually follow. Called wherever a prompt or an
 * agent's tools change, because either side can break the pair. `only` narrows it to one
 * kind of problem (changing tools says nothing about the prompt's variables). */
export function refusePromptProblems(text, tools, known = []) {
  const problems = promptProblems(text, tools, known);
  if (problems.length) throw new ValidationError(problems[0].message);
}

function checkSettings(current, changes) {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    throw new ValidationError("settings must be an object");
  }
  const out = { ...DEFAULT_SETTINGS, ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (key === "call_window") {
      out.call_window = checkWindow(current?.call_window, value);
    } else if (key === "capture_fields") {
      out.capture_fields = checkCaptureFields(value);
    } else if (key === "confirm_answers") {
      out.confirm_answers = Boolean(value);
    } else if (key === "language") {
      if (!LANGUAGE_VALUES.includes(value)) throw new ValidationError(`Language must be one of: ${LANGUAGE_CHOICES}`);
      out.language = value;
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
    coalesce((SELECT array_agg(r.number ORDER BY r.number) FROM routes r WHERE r.agent_id = a.id AND r.org_id = a.org_id), '{}') AS numbers,
    coalesce((SELECT v.prompt FROM prompt_versions v WHERE v.prompt_id = a.active_prompt_id AND v.org_id = a.org_id
              ORDER BY v.seq DESC LIMIT 1), '') AS draft_prompt,
    to_jsonb(lv) - 'prompt' AS live_version, lv.prompt AS live_prompt
  FROM agents a LEFT JOIN agent_versions lv ON lv.id = a.live_version_id`;
const settingsOf = (stored) => ({ ...DEFAULT_SETTINGS, ...stored,
  call_window: { ...DEFAULT_WINDOW, ...stored?.call_window },
  capture_fields: Array.isArray(stored?.capture_fields) ? stored.capture_fields : [],
  confirm_answers: stored?.confirm_answers !== false,
  language: LANGUAGE_VALUES.includes(stored?.language) ? stored.language : DEFAULT_LANGUAGE });

/** Whether the draft says anything the published version does not. Compared field by
 * field rather than by a timestamp, so re-saving the same words is not "a change". */
function draftChanged(a) {
  const v = a.live_version;
  if (!v) return true;
  return a.name !== v.name
    || (a.draft_prompt ?? "") !== (a.live_prompt ?? "")
    || JSON.stringify(a.tools) !== JSON.stringify(v.tools)
    || JSON.stringify(settingsOf(a.settings)) !== JSON.stringify(settingsOf(v.settings));
}

const versionShape = (v, liveId) => (v ? {
  id: v.id, number: v.number, name: v.name, note: v.note ?? "", overrides: v.overrides ?? [],
  published_by_name: v.published_by_name ?? "", live: v.id === liveId,
  published_at: new Date(v.published_at).toISOString(),
} : null);

const shape = (a) => ({ id: a.id, name: a.name, description: a.description, active_prompt_id: a.active_prompt_id,
  tools: a.tools, settings: settingsOf(a.settings), created_at: a.created_at.toISOString(),
  updated_at: a.updated_at.toISOString(), prompt_ids: a.prompt_ids, numbers: a.numbers,
  live_version: versionShape(a.live_version, a.live_version?.id), draft_changed: draftChanged(a) });

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

/** An agent made from a starter template: its prompt, its questions and the tool that saves them. */
export async function createFromTemplate(orgId, id, { name, description } = {}) {
  const t = findTemplate(id);
  if (!t) throw new ValidationError("that template does not exist");
  const made = await create(orgId, { name: name || t.name, description: description || t.description, prompt: t.prompt });
  return update(orgId, made.id, { tools: [...new Set([...made.tools, "save_answer"])], settings: { capture_fields: checkCaptureFields(t.fields) } });
}

export async function create(orgId, { name, description, prompt }) {
  name = cleanText(name, MAX_NAME, "agent name");
  description = cleanText(description, MAX_DESCRIPTION, "description", false);
  const text = promptText(prompt);
  refusePromptProblems(text, DEFAULT_TOOLS, variablesOf(DEFAULT_SETTINGS));
  return inOrg(orgId, async (db) => {
    const id = `ag_${hexId()}`;
    await db.query("INSERT INTO agents (id, name, description, tools, settings, org_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, name, description, DEFAULT_TOOLS, DEFAULT_SETTINGS, orgId]);
    const promptId = await insertPrompt(db, orgId, { name: cleanText(`${name} prompt`, MAX_NAME + 7, "prompt name"), text, agentId: id });
    await db.query("UPDATE agents SET active_prompt_id = $1 WHERE id = $2 AND org_id = $3", [promptId, id, orgId]);
    // Live from the moment it is made: otherwise someone points a number at a new agent,
    // calls it, and hears the default persona. Only later edits are drafts.
    await snapshot(db, orgId, id, { note: "Created" });
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
      // Built-in tools, plus any this organization has defined itself.
      const theirOwn = await customToolNames(orgId);
      const allowed = [...KNOWN_TOOLS, ...theirOwn];
      if (!Array.isArray(tools) || tools.some((t) => !allowed.includes(t))) {
        throw new ValidationError(`tools must be from: ${KNOWN_TOOLS.join(", ")}`);
      }
      next.tools = allowed.filter((t) => tools.includes(t));
    }
    if (settings !== undefined && settings !== null) next.settings = checkSettings(agent.settings, settings);
    if (activePromptId !== undefined && activePromptId !== null) {
      const own = await db.query("SELECT 1 FROM prompts WHERE id = $1 AND agent_id = $2 AND org_id = $3", [String(activePromptId), id, orgId]);
      if (!own.rowCount) throw new ValidationError("the prompt in use must be one of this agent's prompts");
      next.active = activePromptId;
    }
    await db.query(`UPDATE agents SET name = $1, description = $2, tools = $3, settings = $4, active_prompt_id = $5,
      updated_at = now() WHERE id = $6 AND org_id = $7`, [next.name, next.description, next.tools, next.settings, next.active, id, orgId]);
    const saved = await show(db, orgId, id);
    // A draft may be half-finished; it is Publish that refuses. Say what is wrong now
    // so nobody is surprised later.
    return { ...saved, warnings: await draftProblems(db, orgId, id) };
  });
}

// --- drafts and published versions -------------------------------------------
//
// The agents row is the draft. A published version is a snapshot of it, and a call reads
// the snapshot (callConfig), so saving in the Studio no longer changes a call in progress
// or the next one until somebody publishes.

/** The draft as it stands: the agent's own fields plus its prompt's newest text. */
async function draftOf(db, orgId, agentId) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.tools, a.settings, a.active_prompt_id,
       coalesce((SELECT v.prompt FROM prompt_versions v WHERE v.prompt_id = a.active_prompt_id AND v.org_id = a.org_id
                 ORDER BY v.seq DESC LIMIT 1), '') AS prompt
     FROM agents a WHERE a.id = $1 AND a.org_id = $2`, [typeof agentId === "string" ? agentId : "", orgId]);
  if (!rows[0]) throw new NotFoundError("agent");
  return rows[0];
}

/** Everything that would stop this draft going live. */
async function draftProblems(db, orgId, agentId) {
  const draft = await draftOf(db, orgId, agentId);
  return promptProblems(draft.prompt, draft.tools, variablesOf(draft.settings), await customToolLabels(orgId));
}

/** What the page shows beside the Publish button. */
export async function check(orgId, agentId) {
  return inOrg(orgId, async (db) => {
    const problems = await draftProblems(db, orgId, agentId);
    const test = await testStanding(db, orgId, agentId);
    const testOk = !config.REQUIRE_AGENT_TEST || test.status === "passed";
    return { problems, test, test_required: config.REQUIRE_AGENT_TEST,
      can_publish: problems.length === 0 && testOk };
  });
}

/** Writes the draft into a new version and makes it live. Inside a transaction. */
async function snapshot(db, orgId, agentId, { user = null, note = "", overrides = [] } = {}) {
  const draft = await draftOf(db, orgId, agentId);
  const { rows: [last] } = await db.query(
    "SELECT max(number) AS n FROM agent_versions WHERE agent_id = $1 AND org_id = $2", [agentId, orgId]);
  const id = `av_${hexId()}`;
  await db.query(
    `INSERT INTO agent_versions (id, agent_id, org_id, number, name, prompt, tools, settings,
       published_by, published_by_name, note, overrides)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, agentId, orgId, (last?.n ?? 0) + 1, draft.name, draft.prompt, draft.tools, draft.settings,
      user?.id ?? null, user?.name ?? "", String(note).slice(0, 300), JSON.stringify(overrides)]);
  await db.query("UPDATE agents SET live_version_id = $1 WHERE id = $2 AND org_id = $3", [id, agentId, orgId]);
  return id;
}

/** Make the draft live. Refuses a draft the agent could not follow, unless an admin says
 * to publish it anyway, in which case what they overrode is kept on the version for good. */
export async function publish(orgId, agentId, { user = null, note = "", override = false } = {}) {
  return inOrg(orgId, async (db) => {
    await db.query("SELECT 1 FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [typeof agentId === "string" ? agentId : "", orgId]);
    const current = await show(db, orgId, typeof agentId === "string" ? agentId : "");
    if (!current.draft_changed) {
      throw new ValidationError("There is nothing new to publish: the draft matches what is already live.");
    }
    const problems = await draftProblems(db, orgId, agentId);
    if (problems.length && !override) throw new ValidationError(problems[0].message);
    // A draft that has not passed a test of exactly these words is not published unless
    // an admin says so, and then the fact that it was not tested is kept with the version.
    const unmet = [];
    if (config.REQUIRE_AGENT_TEST) {
      const test = await testStanding(db, orgId, agentId);
      if (test.status !== "passed") {
        if (!override) throw new ValidationError(
          test.status === "stale" ? test.message : test.status === "failed"
            ? `The last test of this draft did not pass. ${test.message}`
            : "This draft has not been tested yet. Use Test this agent first.");
        unmet.push({ code: "untested", found: test.status, message: test.message });
      }
    }
    await snapshot(db, orgId, agentId, { user, note, overrides: override ? [...problems, ...unmet] : [] });
    return show(db, orgId, agentId);
  });
}

/** Newest first. */
export async function versions(orgId, agentId) {
  return inOrg(orgId, async (db) => {
    const { rows: [agent] } = await db.query("SELECT live_version_id FROM agents WHERE id = $1 AND org_id = $2",
      [typeof agentId === "string" ? agentId : "", orgId]);
    if (!agent) throw new NotFoundError("agent");
    const { rows } = await db.query(
      "SELECT * FROM agent_versions WHERE agent_id = $1 AND org_id = $2 ORDER BY number DESC", [agentId, orgId]);
    return rows.map((v) => versionShape(v, agent.live_version_id));
  });
}

/** Put an old version back: its words become the draft again and go live at once, as a
 * new version. Nothing in the history is rewritten. */
export async function restore(orgId, agentId, versionId, { user = null } = {}) {
  return inOrg(orgId, async (db) => {
    const { rows: [agent] } = await db.query("SELECT * FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [typeof agentId === "string" ? agentId : "", orgId]);
    if (!agent) throw new NotFoundError("agent");
    const { rows: [version] } = await db.query(
      "SELECT * FROM agent_versions WHERE id = $1 AND agent_id = $2 AND org_id = $3",
      [typeof versionId === "string" ? versionId : "", agentId, orgId]);
    if (!version) throw new NotFoundError("version");
    await db.query("UPDATE agents SET name = $1, tools = $2, settings = $3, updated_at = now() WHERE id = $4 AND org_id = $5",
      [version.name || agent.name, version.tools, version.settings, agentId, orgId]);
    if (agent.active_prompt_id) await addPromptVersion(db, orgId, agent.active_prompt_id, version.prompt);
    await snapshot(db, orgId, agentId, { user, note: `Rolled back to version ${version.number}` });
    return show(db, orgId, agentId);
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

/** Who is on the other end, if we know them. Never throws: a call must start anyway. */
async function contactForCaller(orgId, caller) {
  if (!orgId || !caller) return null;
  try {
    return await contactIdForNumber(orgId, caller);
  } catch {
    return null;
  }
}

/** Everything the prompt editor can offer for this agent. */
export async function variables(orgId, agentId) {
  const agent = await get(orgId, agentId);
  const { rows } = await inOrg(orgId, (db) => db.query(
    `SELECT DISTINCT jsonb_object_keys(details) AS key FROM contacts
     WHERE org_id = $1 AND details <> '{}'::jsonb ORDER BY 1 LIMIT 50`, [orgId]));
  return offered({ captureFields: agent.settings.capture_fields ?? [], detailKeys: rows.map((r) => r.key) });
}

/** What a call with this agent needs, or null. Never throws: it is read at the
 * start of a live call, and an id can arrive from the network. */
export async function callConfig(agentId, { caller = null } = {}) {
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) return null;
  try {
    // The published version, never the draft: what someone is still working on in the
    // Studio must not reach a caller (2026-11-07).
    const { rows } = await asSystem((db) => db.query(`SELECT a.id, a.org_id,
        lv.name, lv.tools, lv.settings, lv.prompt, lv.number AS version
      FROM agents a JOIN agent_versions lv ON lv.id = a.live_version_id
      WHERE a.id = $1`, [agentId]));
    const a = rows[0];
    if (!a) return null;
    const s = settingsOf(a.settings);
    // The organization's own cap on how long any call can be, whatever this agent says.
    const orgCap = (await orgSettings(a.org_id).catch(() => null))?.max_minutes ?? null;
    // The prompt is filled in here, before it ever reaches the model, so the agent is
    // handed plain words and cannot read a {{variable}} out loud.
    const prompt = await fillVariables(a.prompt || "", {
      orgId: a.org_id, contactId: caller ? await contactForCaller(a.org_id, caller) : null,
      phone: caller, agentName: a.name,
    }).catch(() => a.prompt || "");
    return { agent_id: a.id, org_id: a.org_id, name: a.name, prompt: prompt || null,
      tools: a.tools, opening_line: s.opening_line || null,
      custom_tools: await customToolsForCall(a.org_id, a.tools.filter((t) => !KNOWN_TOOLS.includes(t))),
      max_secs: Math.min(s.max_minutes, orgCap ?? Infinity) * 60, ring_secs: Number(s.ring_secs), call_window: s.call_window,
      capture_fields: s.capture_fields, confirm_answers: s.confirm_answers, language: s.language,
      version: a.version };
  } catch (err) {
    logger.error({ err: err.message }, "agent unreadable, the call uses the default persona");
    return null;
  }
}
