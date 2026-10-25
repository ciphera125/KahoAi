// One-off: copy the Python Studio's data (data/*.json, logs/calls/*.jsonl) into
// PostgreSQL. Safe to run again: rows that already exist are left alone, and
// transcripts are only read for calls not yet imported. Passwords keep working
// (same scrypt parameters); everyone signs in again (sessions are not copied).
//
//   node scripts/import-legacy.js [--data ../data] [--calls ../logs/calls]
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, tx } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import * as Call from "../src/models/Call.js";
import { encryptJson } from "../src/utils/crypto.js";
import { CALL_ID } from "../src/utils/phone.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? path.resolve(process.argv[i + 1]) : fallback;
};
const DATA = arg("--data", path.join(ROOT, "data"));
const CALLS = arg("--calls", path.join(ROOT, "logs", "calls"));

async function json(file, fallback) {
  try { return JSON.parse(await readFile(path.join(DATA, file), "utf8")); } catch { return fallback; }
}
async function lines(file) {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch { return []; }
}
const iso = (v) => (typeof v === "number" ? new Date(v * 1000) : v ? new Date(v) : new Date());
const counts = {};
const count = (what, n = 1) => { counts[what] = (counts[what] || 0) + n; };

async function users() {
  const data = await json("users.json", { users: [] });
  for (const u of data.users) {
    const r = await pool.query(`INSERT INTO users (id, name, email, company, role, salt, hash, created_at, seen_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
    [u.id, u.name, u.email, u.company || "", u.role, u.salt, u.hash, iso(u.created_at), u.seen_at ? iso(u.seen_at) : null]);
    count("users", r.rowCount);
    for (const d of u.devices || []) await pool.query("INSERT INTO devices (token_hash, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [d, u.id]);
  }
}

async function agents() {
  const data = await json("agents.json", { agents: {}, prompts: {}, routes: {} });
  await tx(async (db) => {
    for (const a of Object.values(data.agents || {})) {
      const r = await db.query(`INSERT INTO agents (id, name, description, tools, settings, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [a.id, a.name, a.description || "", a.tools || [], a.settings || {}, iso(a.created_at), iso(a.updated_at)]);
      count("agents", r.rowCount);
    }
    for (const p of Object.values(data.prompts || {})) {
      const r = await db.query(`INSERT INTO prompts (id, name, agent_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING`, [p.id, p.name, data.agents?.[p.agent_id] ? p.agent_id : null, iso(p.created_at), iso(p.updated_at)]);
      count("prompts", r.rowCount);
      if (!r.rowCount) continue;
      for (const v of [...(p.versions || [])].reverse()) { // oldest first, so seq orders them
        await db.query("INSERT INTO prompt_versions (id, prompt_id, prompt, saved_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
          [v.id, p.id, v.prompt, iso(v.saved_at)]);
      }
    }
    for (const a of Object.values(data.agents || {})) {
      await db.query("UPDATE agents SET active_prompt_id = $1 WHERE id = $2 AND active_prompt_id IS NULL AND EXISTS (SELECT 1 FROM prompts WHERE id = $1)",
        [a.active_prompt_id, a.id]);
    }
    for (const [number, agentId] of Object.entries(data.routes || {})) {
      await db.query("INSERT INTO routes (number, agent_id) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM agents WHERE id = $2) ON CONFLICT DO NOTHING", [number, agentId]);
    }
  });
}

async function numbers() {
  const data = await json("numbers.json", null);
  if (!data) return;
  await pool.query("INSERT INTO meta (key, value) VALUES ('numbers_seeded', 'imported') ON CONFLICT DO NOTHING");
  for (const n of data.numbers || []) {
    const creds = Object.fromEntries(Object.entries(n.credentials || {}).filter(([, v]) => v));
    const r = await pool.query(`INSERT INTO phone_numbers (id, provider, number, label, credentials_enc, env_backed, is_default, created_at, updated_at)
      SELECT $1, $2, $3, $4, $5, $6, $7 AND NOT EXISTS (SELECT 1 FROM phone_numbers WHERE is_default), $8, $9 ON CONFLICT DO NOTHING`,
    [n.id, n.provider, n.number, n.label || "", Object.keys(creds).length ? encryptJson(creds) : null, Boolean(n.env_backed),
      Boolean(n.is_default), iso(n.created_at), iso(n.updated_at)]);
    count("numbers", r.rowCount);
  }
}

async function contacts() {
  const data = await json("contacts.json", { contacts: [], tags: [] });
  await tx(async (db) => {
    for (const t of data.tags || []) count("tags", (await db.query("INSERT INTO tags (id, name, color) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [t.id, t.name, t.color])).rowCount);
    for (const c of data.contacts || []) {
      const r = await db.query("INSERT INTO contacts (id, name, dnc, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        [c.id, c.name, Boolean(c.dnc), iso(c.created_at)]);
      count("contacts", r.rowCount);
      if (!r.rowCount) continue;
      for (const [i, tag] of (c.tags || []).entries()) await db.query("INSERT INTO contact_tags VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [c.id, tag, i]);
      for (const [i, n] of (c.numbers || []).entries()) {
        await db.query("INSERT INTO contact_numbers (id, contact_id, number, position) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [n.id, c.id, n.number, i]);
        for (const [j, tag] of (n.tags || []).entries()) await db.query("INSERT INTO contact_number_tags VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [n.id, tag, j]);
      }
    }
  });
}

async function activity() {
  for (const a of await lines(path.join(DATA, "activity.jsonl"))) {
    count("notifications", (await pool.query("INSERT INTO activity (id, at, kind, text, view, ref, actor) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
      [a.id, iso(a.at), a.kind, a.text, a.view, a.ref, a.actor])).rowCount);
  }
}

async function calls() {
  const index = await json("call_index.json", {});
  for (const row of await lines(path.join(DATA, "call_outcomes.jsonl"))) {
    if (CALL_ID.test(String(row.call_id))) { await Call.recordOutcome(row.call_id, row); count("call outcomes"); }
  }
  let files = [];
  try { files = (await readdir(CALLS)).filter((f) => f.endsWith(".jsonl")); } catch { /* none */ }
  for (const file of files) {
    const callId = file.replace(/\.jsonl$/, "");
    if (!CALL_ID.test(callId)) continue;
    const done = await pool.query("SELECT 1 FROM call_events WHERE call_id = $1 LIMIT 1", [callId]);
    if (done.rowCount) continue;
    const events = await lines(path.join(CALLS, file));
    const known = index[callId];
    if (known?.peer && !events.some((e) => e.event === "call_party")) {
      events.splice(1, 0, { event: "call_party", number: known.peer, direction: known.direction });
    }
    try {
      const summary = JSON.parse(await readFile(path.join(CALLS, `${callId}.summary.json`), "utf8")).summary;
      if (summary) events.push({ event: "summary", summary });
    } catch { /* no summary */ }
    for (let i = 0; i < events.length; i += Call.MAX_BATCH) await Call.ingest(callId, events.slice(i, i + Call.MAX_BATCH));
    count("transcripts");
  }
}

try {
  await migrate();
  await users();
  await agents();
  await numbers();
  await contacts();
  await activity();
  await calls();
  console.log("Imported:", Object.keys(counts).length ? counts : "nothing new");
} catch (err) {
  console.error(`Import failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
