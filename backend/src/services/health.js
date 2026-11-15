// "Is it really working?" for the people who run the platform: each outside service is tried for
// real, under its own deadline, and answered in plain words. Nothing here changes anything for a
// customer, and no key, token or secret is ever put in an answer.
import { config as liveConfig } from "../config/env.js";
import { pool, poolUsage } from "../db/pool.js";
import * as PhoneNumber from "../models/PhoneNumber.js";
import { checkConnectionBudget, checkDatabaseRole } from "./startup.js";
import { deleteRecording, putText, recordingsConfigured } from "./storage.js";

const config = liveConfig; // `warnings` takes its own settings so a test can try others
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
  ["connections", "Database connections", async () => {
    const u = poolUsage();
    const budget = await checkConnectionBudget();
    // pg counts a request as waiting while it opens a new connection; it is queueing only when the pool is full.
    const queueing = u.waiting > 0 && u.open >= u.max;
    const now = `${u.open} of ${u.max} in use right now${queueing ? `, ${u.waiting} request${u.waiting === 1 ? "" : "s"} waiting for one` : ""}.`;
    if (queueing) return no(`${now} Requests are queueing for the database; raise PGPOOL_MAX if the database allows it. ${budget.message}`);
    return budget.ok ? yes(`${now} ${budget.message}`) : no(`${now} ${budget.message}`);
  }],
  ["model", "Language model (Groq)", async () => {
    if (!config.GROQ_API_KEY) return no("Not set up: GROQ_API_KEY is missing, so Kaho Builder and Test this agent cannot work.");
    const r = await http(`${config.GROQ_API_BASE}/openai/v1/models`, { headers: { Authorization: `Bearer ${config.GROQ_API_KEY}` } });
    if (r.error) return no(`The model service ${r.error}.`);
    if (!r.res.ok) return no(`The model service refused the Studio's key (${r.res.status}).`);
    // The key being accepted is not the same as the model being there: look for the one the Studio really uses.
    const list = (await r.res.json().catch(() => null))?.data;
    if (Array.isArray(list) && !list.some((m) => m?.id === config.GROQ_MODEL_ID)) {
      return no(`The Studio's key works, but this account does not offer the model ${config.GROQ_MODEL_ID}.`);
    }
    return yes(`The Studio's own key was accepted and ${config.GROQ_MODEL_ID} is available. Calls use the phone server's key, which is its own setting.`);
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
    if (!r.res.ok) return no(r.res.status === 402 ? "Plivo has insufficient balance. Add credit in the Plivo console." : `Plivo refused the credentials (${r.res.status}).`);
    // Accepted credentials with an empty balance still cannot place a call, so the balance is part of "working".
    const credit = Number((await r.res.json().catch(() => null))?.cash_credits);
    if (!Number.isFinite(credit)) return yes("Credentials accepted. The balance was not reported, so it could not be checked.");
    if (credit <= 0) return no("Plivo accepts the credentials but the account has no credit left, so calls will fail. Add credit in the Plivo console.");
    return yes(`Credentials accepted. Plivo balance: $${credit.toFixed(2)}.`);
  }],
  ["phone_server", "Phone server (the voice service)", async () => {
    if (!config.PUBLIC_HOST) return no("Not set up: PUBLIC_HOST is missing, so Plivo has nowhere to send calls.");
    const r = await http(`${config.PUBLIC_SCHEME}://${config.PUBLIC_HOST}/answer`);
    if (r.error) return no(`The phone server at ${config.PUBLIC_HOST} ${r.error}. Start it and your tunnel.`);
    // Our phone server refuses an unsigned request (403), or a call with no details (400), or answers (200). A 404 or a
    // gateway error is something else answering at that address, most often a tunnel that is down: calls would not arrive.
    if ([200, 400, 403].includes(r.res.status)) return yes(`The phone server answers at ${config.PUBLIC_HOST}.`);
    return r.res.status >= 500
      ? no(`The phone server answered with an error (${r.res.status}). If you use a tunnel, check that it is running.`)
      : no(`Something answered at ${config.PUBLIC_HOST} but it was not the phone server (HTTP ${r.res.status}). The tunnel may be down or pointing elsewhere, so calls would not arrive.`);
  }],
];

/** Settings that are right for trying things out and wrong for real customers. */
export function warnings(settings = liveConfig) {
  const config = settings;
  const out = [];
  if (config.NODE_ENV !== "production") out.push("NODE_ENV is not production: tools may reach addresses on this machine, and cookies are not marked secure. Set NODE_ENV=production on the live server.");
  if (!config.REQUIRE_AGENT_TEST) out.push("Agents can be published without a passing test (REQUIRE_AGENT_TEST is off).");
  if (config.DATABASE_SSL && config.DATABASE_SSL !== "verify") out.push("The database connection is not certificate-checked (DATABASE_SSL is not verify).");
  if (!config.TRANSFER_NUMBER) out.push("No TRANSFER_NUMBER is set, so an agent cannot hand a call to a person.");
  if (config.BILLING_ENFORCED === false) out.push("BILLING_ENFORCED is off: no organization is charged, locked out or counted, whatever plan it is on. Switch it on before real customers.");
  if (config.SUBSCRIPTION_AUTO_ACTIVATE === true) out.push("SUBSCRIPTION_AUTO_ACTIVATE is on: a plan starts the moment it is chosen, without anyone confirming payment.");
  if (config.WEB_CONCURRENCY > 1 && !config.REDIS_URL) out.push(`${config.WEB_CONCURRENCY} workers are running without REDIS_URL, so each keeps its own rate-limit count and the limits are really ${config.WEB_CONCURRENCY} times higher. Set REDIS_URL.`);
  return out;
}

async function runChecks(list, orgId) {
  const checks = await Promise.all(list.map(async ([id, label, run]) => {
    const t = Date.now();
    let r;
    try { r = await run(orgId); } catch { r = no("The check itself failed."); }
    return { id, label, ...r, ms: Date.now() - t };
  }));
  return { ok: checks.every((c) => c.ok), checks, warnings: warnings() };
}

export const systemHealth = (orgId) => runChecks(CHECKS, orgId);

/** The parts of the platform that are not one organization's: for the admin site. */
export const platformHealth = () => runChecks(CHECKS.filter(([id]) => ["database", "connections", "model", "storage"].includes(id)), null);
