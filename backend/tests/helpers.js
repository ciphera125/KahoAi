import { readFileSync } from "node:fs";
import request from "supertest";
import { createApp, createInternalApp } from "../src/app.js";
import { ownerPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { resetRateLimits } from "../src/middleware/rateLimit.js";

export const ORIGIN = "http://localhost:5173";
const TABLES = ["impersonations", "admin_sessions", "admin_audit", "admins", "minute_ledger", "org_requests", "topups", "subscriptions", "tool_log", "builder_history", "agent_tests", "custom_tools", "tasks", "api_keys", "call_answers", "agent_versions", "error_logs", "bulk_items", "bulk_runs", "meta", "call_events", "calls", "activity", "contact_number_tags", "contact_tags",
  "contact_numbers", "contacts", "tags", "phone_numbers", "routes", "prompt_versions",
  "prompts", "agents", "login_failures", "devices", "sessions", "invites", "memberships", "users", "organizations"];

/** The database owner's connection: sees every row (tests set up and inspect with it). */
export const db = ownerPool();

// The rate card as migration 028 seeded it, read from the migration itself so the tests cannot drift from it.
const RATE_CARD_SQL = readFileSync(new URL("../src/db/migrations/028_billing_and_admin.sql", import.meta.url), "utf8")
  .match(/INSERT INTO plans[\s\S]*?;\n/)[0];

let migrated = false;
export async function freshDb() {
  if (!migrated) { await migrate(); migrated = true; }
  await resetRateLimits();
  await db.query(`TRUNCATE ${TABLES.join(", ")}, plans RESTART IDENTITY CASCADE`);
  await db.query(RATE_CARD_SQL); // a test may edit plans; the next one starts from the real rate card
}

export const app = createApp();
export const internalApp = createInternalApp();

/** A browser: keeps cookies and sends the page's Origin, like the React app does. */
export function browser() {
  const agent = request.agent(app);
  const wrap = (method) => (path) => agent[method](path).set("Origin", ORIGIN).set("Host", "localhost:8020");
  return { get: wrap("get"), post: wrap("post"), patch: wrap("patch"), delete: wrap("delete"), agent };
}

export async function owner(fields = {}) {
  const b = browser();
  const r = await b.post("/api/auth/signup").send({ name: "Asha Rao", email: "asha@acme.in",
    password: "correct horse", organization: "Acme", ...fields });
  if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  b.user = r.body;
  return b;
}

/** Someone who joins the organization with an invite code. Their role is the code's: a viewer unless `role` says otherwise. */
export async function member(ownerBrowser, { role = "viewer", ...fields } = {}) {
  // Straight into the table, so it works for organizations that have not chosen a plan yet.
  const code = `t${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  await db.query("INSERT INTO invites (code, org_id, role, made_by, expires_at) VALUES ($1, $2, $3, 'test', now() + interval '7 days')", [code, ownerBrowser.user.org_id, role]);
  const made = { body: { code } };
  const b = browser();
  const r = await b.post("/api/auth/signup").send({ name: "Ravi", email: "ravi@acme.in",
    password: "another pass", invite: made.body.code, ...fields });
  if (r.status !== 200) throw new Error(`member signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  b.user = r.body;
  return b;
}

export const internal = (method, path) => request(internalApp)[method](path)
  .set("Authorization", `Bearer ${process.env.INTERNAL_API_TOKEN}`);

/** Our number for a test organization: calls the voice service reports on it belong to that organization. */
export const OURS = "+918065520552";
export async function line(b) {
  const r = await b.post("/api/numbers").send({ provider: "plivo", number: OURS, credentials: { auth_id: "AID", auth_token: "tok" } });
  if (r.status !== 200) throw new Error(`adding our line failed: ${JSON.stringify(r.body)}`);
}

/** Settings and prompts are drafts until they are published (migration 009), so a test
 * that wants a change to reach a call has to publish it, exactly as the Studio does. */
export async function publish(b, agentId) {
  const r = await b.post(`/api/agents/${agentId}/publish`).send({});
  if (r.status !== 200) throw new Error(`publish failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
