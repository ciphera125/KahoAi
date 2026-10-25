import request from "supertest";
import { createApp, createInternalApp } from "../src/app.js";
import { ownerPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { resetRateLimits } from "../src/middleware/rateLimit.js";

export const ORIGIN = "http://localhost:5173";
const TABLES = ["bulk_items", "bulk_runs", "meta", "call_events", "calls", "activity", "contact_number_tags", "contact_tags",
  "contact_numbers", "contacts", "tags", "phone_numbers", "routes", "prompt_versions",
  "prompts", "agents", "login_failures", "devices", "sessions", "invites", "memberships", "users", "organizations"];

/** The database owner's connection: sees every row (tests set up and inspect with it). */
export const db = ownerPool();

let migrated = false;
export async function freshDb() {
  if (!migrated) { await migrate(); migrated = true; }
  await resetRateLimits();
  await db.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
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

export async function member(ownerBrowser, fields = {}) {
  const me = await ownerBrowser.get("/api/me");
  const b = browser();
  const r = await b.post("/api/auth/signup").send({ name: "Ravi", email: "ravi@acme.in",
    password: "another pass", invite: me.body.invite_code, ...fields });
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
