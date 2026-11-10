// "Is it really working?" for the people who run the platform: each outside service is tried for
// real, under its own deadline, and answered in plain words. Nothing here changes anything for a
// customer, and no key, token or secret is ever put in an answer.
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import * as PhoneNumber from "../models/PhoneNumber.js";
import { checkDatabaseRole } from "./startup.js";
import { deleteRecording, putText, recordingsConfigured } from "./storage.js";

const deadline = () => AbortSignal.timeout(config.HEALTH_TIMEOUT_MS);
const no = (detail) => ({ ok: false, detail });
const yes = (detail) => ({ ok: true, detail });

/** Never throws: a thrown error becomes a plain "could not reach". */
async function http(url, options = {}) {
  try {
    return { res: await fetch(url, { ...options, signal: deadline(), redirect: "manual" }) };
  } catch (err) {
    return { error: err?.name === "TimeoutError" || err?.name === "AbortError" ? "did not answer in time" : "could not reach it" };
  }
}

const CHECKS = [
  ["database", "Database", async () => {
    try {
      await pool.query("SELECT 1");
      await checkDatabaseRole();
      return yes("Answering, and each organization sees only its own rows.");
    } catch (err) {
      return no(`The database is not usable: ${String(err?.message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[database]").slice(0, 160)}`);
    }
  }],
  ["model", "Language model (Groq)", async () => {
    if (!config.GROQ_API_KEY) return no("Not set up: GROQ_API_KEY is missing, so Kaho Builder and Test this agent cannot work.");
    const r = await http(`${config.GROQ_API_BASE}/openai/v1/models`, { headers: { Authorization: `Bearer ${config.GROQ_API_KEY}` } });
    if (r.error) return no(`The model service ${r.error}.`);
    return r.res.ok ? yes(`Key accepted (${config.GROQ_MODEL_ID}).`) : no(`The model service refused the key (${r.res.status}).`);
  }],
  ["storage", "Storage (recordings and records)", async () => {
    if (!recordingsConfigured()) return no("Not set up: the Supabase settings are missing, so recordings and records stay only in the database.");
    const path = `health/probe-${Date.now()}.txt`;
    if (!(await putText(path, "ok"))) return no("Storage refused or did not answer a small test file, so recordings and records cannot be filed.");
    await deleteRecording(path);
    return yes("A test file was written and removed.");
  }],
  ["plivo", "Phone provider (Plivo)", async (orgId) => {
    const [id, token] = await PhoneNumber.plivoCredentials(orgId);
    if (!id || !token) return no("No Plivo number with working credentials is set up on Numbers.");
    const auth = Buffer.from(`${id}:${token}`).toString("base64");
    const r = await http(`${config.PLIVO_API_BASE}/v1/Account/${encodeURIComponent(id)}/`, { headers: { Authorization: `Basic ${auth}` } });
    if (r.error) return no(`Plivo ${r.error}.`);
    return r.res.ok ? yes("Credentials accepted.") : no(`Plivo refused the credentials (${r.res.status}).`);
  }],
  ["phone_server", "Phone server (the voice service)", async () => {
    if (!config.PUBLIC_HOST) return no("Not set up: PUBLIC_HOST is missing, so Plivo has nowhere to send calls.");
    const r = await http(`${config.PUBLIC_SCHEME}://${config.PUBLIC_HOST}/answer`);
    if (r.error) return no(`The phone server at ${config.PUBLIC_HOST} ${r.error}. Start it and your tunnel.`);
    return r.res.status < 500 ? yes(`Reachable at ${config.PUBLIC_HOST}.`) : no(`The phone server answered with an error (${r.res.status}).`);
  }],
];

/** Settings that are right for trying things out and wrong for real customers. */
function warnings() {
  const out = [];
  if (config.NODE_ENV !== "production") out.push("NODE_ENV is not production: tools may reach addresses on this machine, and cookies are not marked secure. Set NODE_ENV=production on the live server.");
  if (!config.REQUIRE_AGENT_TEST) out.push("Agents can be published without a passing test (REQUIRE_AGENT_TEST is off).");
  if (config.DATABASE_SSL && config.DATABASE_SSL !== "verify") out.push("The database connection is not certificate-checked (DATABASE_SSL is not verify).");
  if (!config.TRANSFER_NUMBER) out.push("No TRANSFER_NUMBER is set, so an agent cannot hand a call to a person.");
  return out;
}

export async function systemHealth(orgId) {
  const checks = await Promise.all(CHECKS.map(async ([id, label, run]) => {
    const t = Date.now();
    let r;
    try { r = await run(orgId); } catch { r = no("The check itself failed."); }
    return { id, label, ...r, ms: Date.now() - t };
  }));
  return { ok: checks.every((c) => c.ok), checks, warnings: warnings() };
}
