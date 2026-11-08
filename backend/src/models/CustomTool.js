// Tools a customer defines themselves: "when the caller asks about their order, call
// our API and tell them the status".
//
// The Studio holds the definition and makes the request. The voice service is told only
// the name, what it is for and what to collect, so an auth token never leaves this
// process and can never be said out loud or talked out of the model.
import { inOrg } from "../db/pool.js";
import { decryptJson, encryptJson, hexId } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { cleanText } from "../utils/text.js";
import { callOut, pick, urlProblem, MAX_TIMEOUT_MS } from "./outbound.js";

export const INPUT_TYPES = ["text", "number", "yes_no"];
export const MAX_INPUTS = 10;
export const MAX_EXTRACT = 10;
const NAME = /^[a-z][a-z0-9_]{1,38}$/;
const SECRET_HEADERS = /authorization|token|key|secret|password|cookie/i;

export const machineName = (label) =>
  String(label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

function checkInputs(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError("the things to collect must be a list");
  if (raw.length > MAX_INPUTS) throw new ValidationError(`at most ${MAX_INPUTS} things to collect`);
  const out = [];
  for (const input of raw) {
    if (!input || typeof input !== "object") throw new ValidationError("each thing to collect must be an object");
    const label = cleanText(input.label, 60, "label");
    const key = machineName(input.key || label);
    if (!key) throw new ValidationError(`'${label}' needs a short name made of letters`);
    if (!INPUT_TYPES.includes(input.type ?? "text")) {
      throw new ValidationError(`'${label}' must be one of: ${INPUT_TYPES.join(", ")}`);
    }
    if (out.some((i) => i.key === key)) throw new ValidationError(`two things to collect share the name '${key}'`);
    out.push({ key, label, type: input.type ?? "text", required: Boolean(input.required),
      description: cleanText(input.description, 200, "description", false),
      example: cleanText(input.example, 60, "example", false) });
  }
  return out;
}

function checkExtract(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("the answers to keep must be an object");
  const entries = Object.entries(raw);
  if (entries.length > MAX_EXTRACT) throw new ValidationError(`at most ${MAX_EXTRACT} answers to keep`);
  const out = {};
  for (const [name, path] of entries) {
    const key = machineName(name);
    if (!key) throw new ValidationError(`'${name}' is not a usable name`);
    if (typeof path !== "string" || !path.trim()) throw new ValidationError(`'${name}' needs a path like $.status`);
    out[key] = path.trim().slice(0, 120);
  }
  return out;
}

function checkHeaders(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("headers must be an object");
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(name)) throw new ValidationError(`'${name}' is not a header name`);
    if (/^(host|content-length)$/i.test(name)) throw new ValidationError(`'${name}' is set for you`);
    out[name] = String(value ?? "").slice(0, 500);
  }
  if (Object.keys(out).length > 10) throw new ValidationError("at most 10 headers");
  return out;
}

/** Headers as the page may see them: a secret becomes dots once it is saved. */
const maskHeaders = (headers) => Object.fromEntries(
  Object.entries(headers ?? {}).map(([k, v]) => [k, SECRET_HEADERS.test(k) || v ? "••••••••" : v]));

const shape = (t, { headers = {} } = {}) => ({
  id: t.id, name: t.name, made_by: t.made_by ?? "form", label: t.label, description: t.description, method: t.method, url: t.url,
  body_template: t.body_template, inputs: t.inputs, extract: t.extract,
  say_while_waiting: t.say_while_waiting, timeout_ms: t.timeout_ms,
  headers: maskHeaders(headers), header_names: Object.keys(headers ?? {}),
  last_test_at: t.last_test_at ? t.last_test_at.toISOString() : null,
  last_test_ok: t.last_test_ok, last_test_note: t.last_test_note,
  created_at: t.created_at.toISOString(),
});

const headersOf = (row) => { try { return decryptJson(row.headers_sealed) ?? {}; } catch { return {}; } };

function checkShape({ label, url, method, timeout_ms: timeoutMs }) {
  const cleanLabel = cleanText(label, 60, "name");
  const name = machineName(cleanLabel);
  if (!NAME.test(name)) throw new ValidationError("the name needs at least two letters");
  const problem = urlProblem(url);
  if (problem) throw new ValidationError(problem);
  if (method && !["GET", "POST", "PUT", "PATCH"].includes(method)) throw new ValidationError("method must be GET, POST, PUT or PATCH");
  const deadline = Math.min(Math.max(Number(timeoutMs) || 6000, 500), MAX_TIMEOUT_MS);
  return { label: cleanLabel, name, deadline };
}

export async function create(orgId, body = {}, { madeBy = "form" } = {}) {
  const { label, name, deadline } = checkShape(body);
  const inputs = checkInputs(body.inputs);
  const extract = checkExtract(body.extract);
  const headers = checkHeaders(body.headers) ?? {};
  return inOrg(orgId, async (db) => {
    const taken = await db.query("SELECT 1 FROM custom_tools WHERE org_id = $1 AND name = $2", [orgId, name]);
    if (taken.rowCount) throw new ValidationError(`you already have a tool called '${name}'`);
    const id = `ct_${hexId()}`;
    await db.query(
      `INSERT INTO custom_tools (id, org_id, name, label, description, method, url, headers_sealed,
         body_template, inputs, say_while_waiting, timeout_ms, extract, made_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, orgId, name, label, cleanText(body.description, 400, "when to use it", false),
        body.method || "POST", String(body.url), encryptJson(headers),
        String(body.body_template ?? "").slice(0, 4000), JSON.stringify(inputs),
        cleanText(body.say_while_waiting, 120, "waiting line", false), deadline, JSON.stringify(extract),
        madeBy === "builder" ? "builder" : "form"]);
    return show(db, orgId, id);
  });
}

async function show(db, orgId, id) {
  const { rows } = await db.query("SELECT * FROM custom_tools WHERE id = $1 AND org_id = $2", [String(id), orgId]);
  if (!rows[0]) throw new NotFoundError("tool");
  return shape(rows[0], { headers: headersOf(rows[0]) });
}

export async function list(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    "SELECT * FROM custom_tools WHERE org_id = $1 ORDER BY label", [orgId]));
  return rows.map((r) => shape(r, { headers: headersOf(r) }));
}

export const get = (orgId, id) => inOrg(orgId, (db) => show(db, orgId, id));

/** The machine names this organization has, so an agent may attach them. */
export async function namesFor(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query("SELECT name FROM custom_tools WHERE org_id = $1", [orgId]));
  return rows.map((r) => r.name);
}

/** {machine name: label}, so a prompt that names one can be told to attach it. Never
 * throws: a check must not break saving. */
export async function labelsFor(orgId) {
  try {
    const { rows } = await inOrg(orgId, (db) => db.query("SELECT name, label FROM custom_tools WHERE org_id = $1", [orgId]));
    return Object.fromEntries(rows.map((r) => [r.name, r.label]));
  } catch {
    return {};
  }
}

/** What the voice service is told: enough to offer the tool to the model, and nothing
 * that could be read out or leaked. No url, no headers. */
export async function forCall(orgId, names) {
  if (!names?.length) return [];
  const { rows } = await inOrg(orgId, (db) => db.query(
    `SELECT name, label, description, inputs, say_while_waiting FROM custom_tools
     WHERE org_id = $1 AND name = ANY($2)`, [orgId, names]));
  return rows.map((r) => ({ name: r.name, label: r.label, description: r.description,
    inputs: r.inputs, say_while_waiting: r.say_while_waiting }));
}

export async function update(orgId, id, body = {}) {
  return inOrg(orgId, async (db) => {
    const { rows } = await db.query("SELECT * FROM custom_tools WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [String(id), orgId]);
    const tool = rows[0];
    if (!tool) throw new NotFoundError("tool");
    const next = {
      label: body.label === undefined ? tool.label : cleanText(body.label, 60, "name"),
      description: body.description === undefined ? tool.description : cleanText(body.description, 400, "when to use it", false),
      method: body.method ?? tool.method,
      url: body.url === undefined ? tool.url : String(body.url),
      body_template: body.body_template === undefined ? tool.body_template : String(body.body_template).slice(0, 4000),
      inputs: body.inputs === undefined ? tool.inputs : checkInputs(body.inputs),
      extract: body.extract === undefined ? tool.extract : checkExtract(body.extract),
      say: body.say_while_waiting === undefined ? tool.say_while_waiting
        : cleanText(body.say_while_waiting, 120, "waiting line", false),
      timeout: body.timeout_ms === undefined ? tool.timeout_ms
        : Math.min(Math.max(Number(body.timeout_ms) || 6000, 500), MAX_TIMEOUT_MS),
    };
    const problem = urlProblem(next.url);
    if (problem) throw new ValidationError(problem);
    if (!["GET", "POST", "PUT", "PATCH"].includes(next.method)) throw new ValidationError("method must be GET, POST, PUT or PATCH");
    // The machine name never changes: a published prompt and an agent's tool list both
    // point at it, and renaming would quietly break them.
    const headers = body.headers === undefined ? headersOf(tool) : (checkHeaders(body.headers) ?? {});
    await db.query(
      `UPDATE custom_tools SET label = $1, description = $2, method = $3, url = $4, headers_sealed = $5,
         body_template = $6, inputs = $7, say_while_waiting = $8, timeout_ms = $9, extract = $10,
         updated_at = now() WHERE id = $11 AND org_id = $12`,
      [next.label, next.description, next.method, next.url, encryptJson(headers), next.body_template,
        JSON.stringify(next.inputs), next.say, next.timeout, JSON.stringify(next.extract), String(id), orgId]);
    return show(db, orgId, id);
  });
}

export async function remove(orgId, id) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    "DELETE FROM custom_tools WHERE id = $1 AND org_id = $2 RETURNING name, label", [String(id), orgId]));
  if (!rows[0]) throw new NotFoundError("tool");
  return rows[0];
}

// --- running one --------------------------------------------------------------

/** {{input.order_number}} in the body or the URL, filled from what the agent collected.
 *
 * The template is written with its own quotes ("order_id": "{{input.order_number}}"), so
 * a string goes in escaped but without adding another pair: what the caller said cannot
 * break out of the string and change the shape of the body. A number or a yes/no goes in
 * bare, so it can be used unquoted. In a URL everything is percent-encoded instead. */
function fillTemplate(template, values, { json = true } = {}) {
  return String(template ?? "").replace(/\{\{\s*input\.([a-z0-9_]{1,40})\s*\}\}/gi, (_, key) => {
    const value = values[key];
    if (value === undefined || value === null) return json ? "null" : "";
    if (!json) return encodeURIComponent(String(value));
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(String(value)).slice(1, -1);
  });
}

/** Run a tool for real. `values` are what the agent collected from the caller. */
export async function run(orgId, name, values = {}) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    "SELECT * FROM custom_tools WHERE org_id = $1 AND name = $2", [orgId, String(name)]));
  const tool = rows[0];
  if (!tool) return { ok: false, message: "I cannot do that on this call." };

  const missing = (tool.inputs ?? []).filter((i) => i.required && (values[i.key] === undefined || values[i.key] === ""));
  if (missing.length) return { ok: false, message: `Ask them for the ${missing[0].label.toLowerCase()} first.` };

  const headers = { ...headersOf(tool) };
  const url = fillTemplate(tool.url, values, { json: false });
  let body = null;
  if (["POST", "PUT", "PATCH"].includes(tool.method)) {
    body = fillTemplate(tool.body_template || "{}", values);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
  }
  const result = await callOut({ url, method: tool.method, headers, body, timeoutMs: tool.timeout_ms });
  if (!result.ok) {
    // Nothing about the address, the headers or the error text goes back: the agent
    // would say it out loud.
    return { ok: false, message: "I could not get that just now. Tell them you will check and come back." };
  }
  const kept = {};
  for (const [variable, path] of Object.entries(tool.extract ?? {})) {
    const found = pick(result.body, path);
    if (found !== undefined && (typeof found !== "object" || found === null)) kept[variable] = String(found);
  }
  return { ok: true, values: kept };
}

/** The "Test this tool" button: the same request, with made-up values, reported in full
 * to the person setting it up (who is allowed to see their own API's answer). */
export async function test(orgId, id, values = {}) {
  const tool = await get(orgId, id);
  const sample = Object.fromEntries((tool.inputs ?? []).map((i) => [i.key, values[i.key] ?? i.example ?? "test"]));
  const result = await run(orgId, tool.name, sample);
  const detail = await inOrg(orgId, async (db) => {
    const { rows } = await db.query("SELECT * FROM custom_tools WHERE id = $1 AND org_id = $2", [String(id), orgId]);
    const headers = headersOf(rows[0]);
    const url = fillTemplate(rows[0].url, sample, { json: false });
    const body = ["POST", "PUT", "PATCH"].includes(rows[0].method)
      ? fillTemplate(rows[0].body_template || "{}", sample) : null;
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type") && body) headers["Content-Type"] = "application/json";
    return callOut({ url, method: rows[0].method, headers, body, timeoutMs: rows[0].timeout_ms });
  });
  const note = detail.ok ? `Answered ${detail.status}.` : (detail.problem ?? "It did not work.");
  await inOrg(orgId, (db) => db.query(
    "UPDATE custom_tools SET last_test_at = now(), last_test_ok = $1, last_test_note = $2 WHERE id = $3 AND org_id = $4",
    [Boolean(detail.ok), note.slice(0, 200), String(id), orgId]));
  return { ok: Boolean(detail.ok), status: detail.status ?? null, note,
    sent: sample, answer: detail.body ?? detail.text?.slice(0, 2000) ?? null,
    kept: result.ok ? result.values : {} };
}
