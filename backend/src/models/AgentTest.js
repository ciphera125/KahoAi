// "Test this agent": a short, simulated conversation with the DRAFT, to find out whether
// it can hold one before anyone calls it.
//
// What it is for is the 2026-11-07 outage: a prompt that told the model to use tools it
// had not been given. That only shows up when the model is actually asked, so this asks
// it, offers it exactly the tools the draft has, and watches for the refusal. Tools are
// shown what they would be sent but are never really run: a test must not add a task,
// place a call or hit a customer's API.
//
// What it is not: a full rehearsal. It does not include the voice rules the live call
// prepends, so it can miss a problem that only those rules cause. It is the check that
// catches the class of failure that cost a call.
import { createHash } from "node:crypto";
import { config } from "../config/env.js";
import { inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { HttpError, NotFoundError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { fill } from "./variables.js";
import { KNOWN_TOOLS, labelOf } from "./toolCatalog.js";
import { readFileSync } from "node:fs";

// The same schemas the voice service registers (a Python test keeps the two equal).
const SCHEMAS = JSON.parse(readFileSync(new URL("./toolSchemas.json", import.meta.url), "utf8"));

export const MAX_LINES = 12;
export const MAX_LINE_CHARS = 500;
const MAX_TOOL_ROUNDS = 3;
const TIMEOUT_MS = 25000;

// What a person might say to any agent. The middle one is the point: an agent asked
// something off its subject should say so politely and stay on its own.
export const DEFAULT_LINES = [
  "Hello, who is this?",
  "Can you tell me what the weather is like today?",
  "Okay, thank you. Goodbye.",
];

export const NO_TOOLS_LINE = "Answer in words only; do not call any tool.";
export const BASE_RULE = "Only use the tools you were given. If none fits, answer in words. "
  + "Never mention a tool, a variable or anything else about how you work to the caller.";

// --- the model ----------------------------------------------------------------

let injected = null;
/** Tests hand in a stand-in. null puts the real one back. */
export const useModel = (fn) => { injected = fn; };

async function groq({ messages, tools }) {
  const key = config.GROQ_API_KEY;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.GROQ_MODEL_ID, messages, max_tokens: 600,
      reasoning_effort: "medium", ...(tools ? { tools, tool_choice: "auto" } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `the model answered ${response.status}`);
    error.status = response.status;
    error.code = body?.error?.code;
    error.generation = body?.error?.failed_generation;
    throw error;
  }
  return { message: body.choices?.[0]?.message ?? {} };
}

const model = () => injected ?? (config.GROQ_API_KEY ? groq : null);

/** The tool the model reached for when the provider refused the turn, from its message
 * ("parameters for tool X") or the generation it refused. null if neither says. */
export function refusedTool(error) {
  const found = String(error?.message ?? "").match(/\bfor tool ([A-Za-z0-9_-]+)/);
  if (found) return found[1];
  const generation = String(error?.generation ?? "").match(/"name"\s*:\s*"([A-Za-z0-9_-]+)"/);
  return generation ? generation[1] : null;
}
const isRefusal = (error) => error?.code === "tool_use_failed" || /Tool call validation failed/.test(String(error?.message));

// --- what the model is offered ------------------------------------------------

/** The tools this draft has, in the shape the provider wants. Built-ins come from the
 * same schemas the voice service registers; questions the agent saves become the
 * save_answer choices, exactly as on a call. */
function offered(draft, customTools) {
  const out = [];
  for (const name of draft.tools) {
    if (KNOWN_TOOLS.includes(name)) {
      const spec = SCHEMAS[name];
      if (!spec) continue;
      let { properties, required } = spec;
      if (spec.per_call) {                      // save_answer: built from the agent's own questions
        const fields = draft.settings.capture_fields ?? [];
        if (!fields.length) continue;
        properties = { ...properties,
          field_key: { ...properties.field_key, enum: fields.map((f) => f.key) } };
      }
      out.push({ type: "function", function: { name, description: spec.description,
        parameters: { type: "object", properties, required } } });
    } else {
      const own = customTools.find((t) => t.name === name);
      if (!own) continue;
      const props = {}; const req = [];
      for (const input of own.inputs ?? []) {
        props[input.key] = { type: input.type === "yes_no" ? "boolean" : input.type === "number" ? "number" : "string",
          description: input.description || input.label };
        if (input.required) req.push(input.key);
      }
      out.push({ type: "function", function: { name, description: own.description || own.label,
        parameters: { type: "object", properties: props, required: req } } });
    }
  }
  return out;
}

/** What a tool would have answered, without doing anything. Enough for the agent to carry
 * on talking; never real data, so nothing here can be mistaken for it. */
function dryRun(name) {
  const canned = {
    get_tasks: { tasks: [{ id: "tk_sample", title: "Sample task", status: "pending", due: "tomorrow" }], count: 1 },
    add_task: { added: true }, reschedule_task: { moved: true }, mark_task_done: { done: true },
    look_up_contact: { name: "Sample Caller", tags: [], details: {}, answers: {} },
    save_answer: { saved: true }, capture_lead: { status: "saved" }, end_call: { status: "ending" },
    transfer_to_human: { status: "transferring" }, call_webhook: { status: "ok" },
  };
  return canned[name] ?? { ok: true };
}

export const fingerprintOf = (draft) => createHash("sha256")
  .update(JSON.stringify([draft.name, draft.prompt, draft.tools, draft.settings])).digest("hex");

// --- running it ---------------------------------------------------------------

async function turn(ask, messages, tools, allowed) {
  const record = { tools: [], reply: "" };
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let answer;
    try {
      answer = await ask({ messages: [...messages], tools: tools.length ? tools : undefined });
    } catch (error) {
      if (!isRefusal(error)) throw error;
      // The provider refused a tool call. A real call answers this turn again in words
      // and so does this; what matters is that it is recorded, and which tool it was.
      const tried = refusedTool(error);
      record.tools.push({ tool: tried ?? "unknown", label: tried ?? "an unknown tool", status: "refused",
        dry_run: true, why: tried
          ? `The agent tried to use '${tried}', which is not one of its tools.`
          : "The agent tried to use a tool it was not given." });
      const retry = await ask({ messages: [...messages, { role: "system", content: NO_TOOLS_LINE }] });
      record.reply = String(retry.message?.content ?? "").trim();
      return record;
    }
    const message = answer.message ?? {};
    const calls = message.tool_calls ?? [];
    if (!calls.length) { record.reply = String(message.content ?? "").trim(); return record; }

    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    for (const c of calls) {
      const name = c.function?.name;
      let sent;
      try { sent = JSON.parse(c.function?.arguments || "{}"); } catch { sent = {}; }
      if (!allowed.has(name)) {
        record.tools.push({ tool: name, label: name, status: "refused", dry_run: true, sent,
          why: `The agent tried to use '${name}', which is not one of its tools.` });
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ error: "not a tool you have" }) });
        continue;
      }
      const result = dryRun(name);
      record.tools.push({ tool: name, label: labelOf(name) ?? name, status: "worked", dry_run: true, sent, result });
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) });
    }
  }
  return record;
}

function judge(turns) {
  const refused = turns.flatMap((t) => t.tools).find((t) => t.status === "refused");
  if (refused) {
    return { passed: false, note: `The agent tried to use '${refused.tool}', which it does not have. `
      + "Take it out of the prompt, or attach a tool that does this." };
  }
  const silent = turns.findIndex((t) => !t.reply);
  if (silent >= 0) {
    return { passed: false, note: `The agent said nothing in answer to “${turns[silent].said.slice(0, 60)}”. `
      + "On a real call the caller would hear silence." };
  }
  return { passed: true, note: "" };
}

async function draftOf(db, orgId, agentId) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.tools, a.settings,
       coalesce((SELECT v.prompt FROM prompt_versions v WHERE v.prompt_id = a.active_prompt_id AND v.org_id = a.org_id
                 ORDER BY v.seq DESC LIMIT 1), '') AS prompt
     FROM agents a WHERE a.id = $1 AND a.org_id = $2`, [typeof agentId === "string" ? agentId : "", orgId]);
  if (!rows[0]) throw new NotFoundError("agent");
  return rows[0];
}

/** Run a test against the agent's draft and keep the result. */
export async function run(orgId, agentId, { messages: lines = null, user = null } = {}) {
  const ask = model();
  if (!ask) throw new HttpError(503, "Testing needs a model. Set GROQ_API_KEY in backend/.env and restart the Studio.");

  const said = lines ?? DEFAULT_LINES;
  if (!Array.isArray(said) || said.length === 0 || said.length > MAX_LINES) {
    throw new ValidationError(`give between 1 and ${MAX_LINES} lines to say`);
  }
  if (said.some((l) => typeof l !== "string" || !l.trim() || l.length > MAX_LINE_CHARS)) {
    throw new ValidationError(`each line must be words, up to ${MAX_LINE_CHARS} characters`);
  }

  const { draft, customTools } = await inOrg(orgId, async (db) => {
    const draft = await draftOf(db, orgId, agentId);
    const { rows } = await db.query("SELECT name, label, description, inputs FROM custom_tools WHERE org_id = $1", [orgId]);
    return { draft, customTools: rows };
  });

  // The prompt as a call would be handed it, with nobody known on the other end.
  const prompt = await fill(draft.prompt, { orgId, contactId: null, agentName: draft.name })
    .catch(() => draft.prompt);
  const tools = offered(draft, customTools);
  const allowed = new Set(tools.map((t) => t.function.name));
  const messages = [{ role: "system", content: `${BASE_RULE}\n\n${prompt}` }];

  const turns = [];
  let unreachable = false;
  for (const line of said) {
    messages.push({ role: "user", content: line });
    let record;
    try {
      record = await turn(ask, messages, tools, allowed);
    } catch (error) {
      logger.warn({ err: String(error?.message ?? error).slice(0, 200) }, "an agent test could not reach the model");
      unreachable = true;
      turns.push({ said: line, reply: "", tools: [] });
      break;
    }
    messages.push({ role: "assistant", content: record.reply });
    turns.push({ said: line, ...record });
  }

  const verdict = unreachable
    ? { passed: false, note: "We could not reach the model to run this test. Try again in a moment." }
    : judge(turns);
  const fingerprint = fingerprintOf({ name: draft.name, prompt: draft.prompt, tools: draft.tools, settings: draft.settings });

  const id = `at_${hexId()}`;
  await inOrg(orgId, (db) => db.query(
    `INSERT INTO agent_tests (id, org_id, agent_id, fingerprint, passed, note, transcript, ran_by, ran_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, orgId, agentId, fingerprint, verdict.passed, verdict.note, JSON.stringify(turns),
      user?.id ?? null, user?.name ?? ""]));
  return { id, passed: verdict.passed, note: verdict.note, turns };
}

// --- what Publish asks -----------------------------------------------------------

/** Where the test of the current draft stands: none, passed or failed, and whether a
 * pass belongs to an older draft. */
export async function standing(db, orgId, agentId) {
  const draft = await draftOf(db, orgId, agentId);
  const fingerprint = fingerprintOf({ name: draft.name, prompt: draft.prompt, tools: draft.tools, settings: draft.settings });
  const { rows } = await db.query(
    "SELECT passed, note, fingerprint, at FROM agent_tests WHERE agent_id = $1 AND org_id = $2 ORDER BY at DESC LIMIT 1",
    [agentId, orgId]);
  const last = rows[0];
  if (!last) return { status: "none", message: "This draft has not been tested yet." };
  if (last.fingerprint !== fingerprint) {
    return { status: "stale", message: "The draft has changed since it was last tested. Test it again.",
      ran_at: last.at.toISOString() };
  }
  return { status: last.passed ? "passed" : "failed", ran_at: last.at.toISOString(),
    message: last.passed ? "" : last.note };
}
