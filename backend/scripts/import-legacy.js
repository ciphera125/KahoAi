// One-off: copy the Python Studio's data (data/*.json, logs/calls/*.jsonl) into
// one organization in PostgreSQL. Safe to run again: rows that already exist
// are left alone, and transcripts are only read for calls not yet imported.
// Passwords keep working (same scrypt parameters); everyone signs in again
// (sessions are not copied).
//
//   node scripts/import-legacy.js [--org org_xxxxxxxxxxxx | --org-name "Acme"] [--data ../data] [--calls ../logs/calls]
//
// Without --org, a new organization is made (named by --org-name, else the old
// owner's company) and the old owner owns it. Into an existing organization,
// the old owner joins as an admin (an organization has one owner).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asSystem, pool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import * as Call from "../src/models/Call.js";
import { encryptJson, hexId } from "../src/utils/crypto.js";
import { CALL_ID } from "../src/utils/phone.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function json(dir, file, fallback) {
  try { return JSON.parse(await readFile(path.join(dir, file), "utf8")); } catch { return fallback; }
}
async function lines(file) {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch { return []; }
}
const iso = (v) => (typeof v === "number" ? new Date(v * 1000) : v ? new Date(v) : new Date());

/** Import into `orgId`, or into a new organization named `orgName`. Returns {orgId, counts} (new rows only). */
export async function importLegacy({ data = path.join(ROOT, "data"), calls: callsDir = path.join(ROOT, "logs", "calls"),
  orgId = null, orgName = null } = {}) {
  const counts = {};
  const count = (what, n = 1) => { if (n) counts[what] = (counts[what] || 0) + n; };
  const users = (await json(data, "users.json", { users: [] })).users || [];
  let fresh = false;

  await asSystem(async (db) => {
    if (orgId) {
      if (!(await db.query("SELECT 1 FROM organizations WHERE id = $1", [orgId])).rowCount) throw new Error(`no organization ${orgId}`);
    } else {
      orgId = `org_${hexId()}`;
      fresh = true;
      const name = (orgName || users.find((u) => u.role === "owner")?.company || "Imported organization").slice(0, 80);
      await db.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, name]);
    }

    for (const u of users) {
      // An organization has one owner: into an existing one, the old owner is an admin.
      const role = u.role === "owner" && !fresh ? "admin" : (u.role === "owner" ? "owner" : "member");
      const r = await db.query(`INSERT INTO users (id, name, email, company, role, salt, hash, created_at, seen_at, org_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
      [u.id, u.name, String(u.email).toLowerCase(), u.company || "", role, u.salt, u.hash, iso(u.created_at),
        u.seen_at ? iso(u.seen_at) : null, orgId]);
      count("users", r.rowCount);
      if (!r.rowCount) { // already here: make sure they are in this organization
        await db.query(`INSERT INTO memberships (user_id, org_id, role) SELECT id, $2, $3 FROM users WHERE id = $1 OR email = $4
          ON CONFLICT DO NOTHING`, [u.id, orgId, role, String(u.email).toLowerCase()]);
      }
      for (const d of u.devices || []) {
        await db.query("INSERT INTO devices (token_hash, user_id) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM users WHERE id = $2) ON CONFLICT DO NOTHING", [d, u.id]);
      }
    }

    const ag = await json(data, "agents.json", { agents: {}, prompts: {}, routes: {} });
    for (const a of Object.values(ag.agents || {})) {
      count("agents", (await db.query(`INSERT INTO agents (id, name, description, tools, settings, created_at, updated_at, org_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [a.id, a.name, a.description || "", a.tools || [], a.settings || {}, iso(a.created_at), iso(a.updated_at), orgId])).rowCount);
    }
    for (const p of Object.values(ag.prompts || {})) {
      const r = await db.query(`INSERT INTO prompts (id, name, agent_id, created_at, updated_at, org_id) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING`, [p.id, p.name, ag.agents?.[p.agent_id] ? p.agent_id : null, iso(p.created_at), iso(p.updated_at), orgId]);
      count("prompts", r.rowCount);
      if (!r.rowCount) continue;
      for (const v of [...(p.versions || [])].reverse()) { // oldest first, so seq orders them
        await db.query("INSERT INTO prompt_versions (id, prompt_id, prompt, saved_at, org_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
          [v.id, p.id, v.prompt, iso(v.saved_at), orgId]);
      }
    }
    for (const a of Object.values(ag.agents || {})) {
      await db.query(`UPDATE agents SET active_prompt_id = $1 WHERE id = $2 AND org_id = $3 AND active_prompt_id IS NULL
        AND EXISTS (SELECT 1 FROM prompts WHERE id = $1 AND org_id = $3)`, [a.active_prompt_id, a.id, orgId]);
    }
    for (const [number, agentId] of Object.entries(ag.routes || {})) {
      await db.query(`INSERT INTO routes (number, agent_id, org_id) SELECT $1, $2, $3
        WHERE EXISTS (SELECT 1 FROM agents WHERE id = $2 AND org_id = $3) ON CONFLICT DO NOTHING`, [number, agentId, orgId]);
    }

    const nums = await json(data, "numbers.json", null);
    if (nums) {
      await db.query("INSERT INTO meta (key, value) VALUES ('numbers_seeded', 'imported') ON CONFLICT DO NOTHING");
      for (const n of nums.numbers || []) {
        const creds = Object.fromEntries(Object.entries(n.credentials || {}).filter(([, v]) => v));
        count("numbers", (await db.query(`INSERT INTO phone_numbers (id, provider, number, label, credentials_enc, env_backed, is_default,
            created_at, updated_at, org_id)
          SELECT $1, $2, $3, $4, $5, $6, $7 AND NOT EXISTS (SELECT 1 FROM phone_numbers WHERE is_default AND org_id = $10), $8, $9, $10
          ON CONFLICT DO NOTHING`,
        [n.id, n.provider, n.number, n.label || "", Object.keys(creds).length ? encryptJson(creds) : null, Boolean(n.env_backed),
          Boolean(n.is_default), iso(n.created_at), iso(n.updated_at), orgId])).rowCount);
      }
    }

    const ct = await json(data, "contacts.json", { contacts: [], tags: [] });
    for (const t of ct.tags || []) {
      count("tags", (await db.query("INSERT INTO tags (id, name, color, org_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        [t.id, t.name, t.color, orgId])).rowCount);
    }
    for (const c of ct.contacts || []) {
      const r = await db.query("INSERT INTO contacts (id, name, dnc, created_at, org_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        [c.id, c.name, Boolean(c.dnc), iso(c.created_at), orgId]);
      count("contacts", r.rowCount);
      if (!r.rowCount) continue;
      for (const [i, tag] of (c.tags || []).entries()) {
        await db.query("INSERT INTO contact_tags (contact_id, tag_id, position, org_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [c.id, tag, i, orgId]);
      }
      for (const [i, n] of (c.numbers || []).entries()) {
        await db.query("INSERT INTO contact_numbers (id, contact_id, number, position, org_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
          [n.id, c.id, n.number, i, orgId]);
        for (const [j, tag] of (n.tags || []).entries()) {
          await db.query("INSERT INTO contact_number_tags (number_id, tag_id, position, org_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
            [n.id, tag, j, orgId]);
        }
      }
    }

    for (const a of await lines(path.join(data, "activity.jsonl"))) {
      count("notifications", (await db.query(`INSERT INTO activity (id, at, kind, text, view, ref, actor, org_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [a.id, iso(a.at), a.kind, a.text, a.view, a.ref, a.actor, orgId])).rowCount);
    }
  });

  const index = await json(data, "call_index.json", {});
  for (const row of await lines(path.join(data, "call_outcomes.jsonl"))) {
    if (!CALL_ID.test(String(row.call_id))) continue;
    const known = (await pool.query("SELECT 1 FROM calls WHERE call_id = $1", [row.call_id])).rowCount;
    await Call.recordOutcome(row.call_id, row, { orgId });
    if (!known) count("call outcomes");
  }
  let files = [];
  try { files = (await readdir(callsDir)).filter((f) => f.endsWith(".jsonl")); } catch { /* none */ }
  for (const file of files) {
    const callId = file.replace(/\.jsonl$/, "");
    if (!CALL_ID.test(callId)) continue;
    if ((await asSystem((db) => db.query("SELECT 1 FROM call_events WHERE call_id = $1 LIMIT 1", [callId]))).rowCount) continue;
    const events = await lines(path.join(callsDir, file));
    const known = index[callId];
    if (known?.peer && !events.some((e) => e.event === "call_party")) {
      events.splice(1, 0, { event: "call_party", number: known.peer, direction: known.direction });
    }
    try {
      const summary = JSON.parse(await readFile(path.join(callsDir, `${callId}.summary.json`), "utf8")).summary;
      if (summary) events.push({ event: "summary", summary });
    } catch { /* no summary */ }
    await Call.recordOutcome(callId, {}, { orgId }); // the call belongs to this organization before its lines arrive
    for (let i = 0; i < events.length; i += Call.MAX_BATCH) await Call.ingest(callId, events.slice(i, i + Call.MAX_BATCH));
    count("transcripts");
  }
  return { orgId, counts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  try {
    await migrate();
    const { orgId, counts } = await importLegacy({
      data: path.resolve(arg("--data", path.join(ROOT, "data"))), calls: path.resolve(arg("--calls", path.join(ROOT, "logs", "calls"))),
      orgId: arg("--org"), orgName: arg("--org-name") });
    console.log(`Imported into ${orgId}:`, Object.keys(counts).length ? counts : "nothing new");
  } catch (err) {
    console.error(`Import failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
