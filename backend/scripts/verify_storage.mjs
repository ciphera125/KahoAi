// Read-only check that what the database says was saved is what Supabase Storage really holds, in the right
// bucket and folder, as spreadsheets only, with no e-mail, phone number, name or password in them.
//   node scripts/verify_storage.mjs        (from backend/, with backend/.env)
// Exit code 1 if anything is wrong. Prints counts, never the content of a file.
import "dotenv/config";
await import("../src/app.js");
const { systemQuery, pool } = await import("../src/db/pool.js");
const { config } = await import("../src/config/env.js");
const { redactPII } = await import("../src/models/redact.js");
const { FOLDERS, ADMIN_FOLDERS } = await import("../src/services/archive.js");
const { parseCsv } = await import("../src/utils/csv.js");

const MAIN = config.SUPABASE_RECORDINGS_BUCKET, ADMIN = config.SUPABASE_ADMIN_BUCKET;
const base = `${config.SUPABASE_URL}/storage/v1`;
const H = { Authorization: `Bearer ${config.SUPABASE_SECRET_KEY}`, apikey: config.SUPABASE_SECRET_KEY };
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const problems = [];
const bad = (what) => { problems.push(what); console.log(`  PROBLEM: ${what}`); };
const head = async (b, path) => { const r = await fetch(`${base}/object/${b}/${enc(path)}`, { method: "HEAD", headers: H }); return r.ok ? Number(r.headers.get("content-length")) : null; };
const get = async (b, path) => { const r = await fetch(`${base}/object/${b}/${enc(path)}`, { headers: H }); return r.ok ? await r.text() : null; };
const ls = async (b, prefix) => (await (await fetch(`${base}/object/list/${b}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ prefix, limit: 1000 }) })).json());
const walk = async (b, prefix) => { const out = []; for (const o of await ls(b, prefix)) { const p = prefix ? `${prefix}/${o.name}` : o.name; if (o.id) out.push(p); else out.push(...await walk(b, p)); } return out; };
const table = (t) => parseCsv(t.replace(/^﻿/, ""));
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;
const NUMBER = /\+?\d(?:[\s().-]?\d){8,}/;
const dayOf = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));

if (!MAIN) { console.log("SUPABASE_RECORDINGS_BUCKET is not set."); process.exit(1); }
console.log(`Customers' bucket: ${MAIN}`);
const top = (await ls(MAIN, "")).map((o) => o.name + (o.id ? "" : "/"));
console.log(`  ${top.join("  ")}`);
const EXPECT = new Set(Object.values(FOLDERS).map((f) => `${f}/`));
for (const f of top) if (!EXPECT.has(f)) bad(`unexpected item at the top of the customers' bucket: ${f}`);
for (const f of EXPECT) if (!top.includes(f)) console.log(`  (empty so far: ${f})`);

console.log("\nCalls:");
const calls = (await systemQuery(`SELECT c.call_id, c.org_id, c.ended_at, c.has_transcript, c.recording_path, c.recording_bytes, c.transcript_path, c.turns,
    (SELECT count(*)::int FROM call_events e WHERE e.call_id = c.call_id AND e.event = 'turn') AS turn_rows,
    (SELECT ct.name FROM contact_numbers cn JOIN contacts ct ON ct.id = cn.contact_id AND ct.org_id = cn.org_id WHERE cn.number = c.peer AND cn.org_id = c.org_id LIMIT 1) AS contact
  FROM calls c ORDER BY c.started_at`)).rows;
let rec = 0, tr = 0;
for (const c of calls) {
  const id = c.call_id.slice(0, 8);
  if (c.recording_path) {
    rec++;
    if (!c.recording_path.startsWith(`${FOLDERS.recordings}/`)) bad(`${id}: recording is not in ${FOLDERS.recordings} (${c.recording_path.split("/")[0]})`);
    const size = await head(MAIN, c.recording_path);
    if (size === null) bad(`${id}: the recording is in the database but NOT in Storage`);
    else if (c.recording_bytes && size !== c.recording_bytes) bad(`${id}: recording size differs (database ${c.recording_bytes}, Storage ${size})`);
  }
  if (c.has_transcript) {
    if (!c.transcript_path) bad(`${id}: has a transcript but none is filed in ${FOLDERS.transcripts}`);
    else {
      tr++;
      if (!c.transcript_path.startsWith(`${FOLDERS.transcripts}/`) || !c.transcript_path.endsWith(".csv")) bad(`${id}: transcript is not a spreadsheet in ${FOLDERS.transcripts}`);
      const text = await get(MAIN, c.transcript_path);
      if (text === null) bad(`${id}: the transcript is in the database but NOT in Storage`);
      else {
        const lines = table(text).filter((r) => r[1] === "Agent" || r[1] === "Caller").length;
        if (lines !== c.turn_rows) bad(`${id}: transcript has ${lines} rows, the database has ${c.turn_rows} turns`);
        if (EMAIL.test(text)) bad(`${id}: an e-mail address is in the transcript`);
        if (NUMBER.test(text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""))) bad(`${id}: a long number (phone?) is in the transcript`);
        for (const part of String(c.contact ?? "").split(/\s+/).filter((p) => p.length >= 3)) if (redactPII(text, { names: [part] }) !== text) bad(`${id}: the contact's name appears in the transcript`);
      }
    }
  }
}
console.log(`  ${calls.length} calls; ${rec} recordings and ${tr} transcripts, each checked in Storage`);

console.log("\nCall log (one row per finished call, per organization and day):");
const dbCalls = (await systemQuery("SELECT org_id, to_char(ended_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day, count(*)::int AS n FROM calls WHERE ended_at IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2")).rows;
let callsOk = 0;
for (const d of dbCalls) {
  const p = `${FOLDERS.calls}/${d.org_id}/${d.day.slice(0, 4)}/${d.day.slice(5, 7)}/${d.day}.csv`;
  const t = await get(MAIN, p);
  const n = t === null ? null : table(t).length - 1;
  if (n === null) bad(`${p} is missing`); else if (n !== d.n) bad(`${p}: ${n} rows filed, ${d.n} calls in the database`); else callsOk++;
}
console.log(`  ${callsOk} of ${dbCalls.length} day-files match`);

console.log("\nWho changed what (database rows against filed rows, per organization and day):");
const dbDays = (await systemQuery("SELECT org_id, to_char(at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day, count(*)::int AS n FROM audit_log GROUP BY 1, 2 ORDER BY 1, 2")).rows;
let auditOk = 0;
for (const d of dbDays) {
  const p = `${FOLDERS.changes}/${d.org_id}/${d.day.slice(0, 4)}/${d.day.slice(5, 7)}/${d.day}.csv`;
  const t = await get(MAIN, p);
  const n = t === null ? null : table(t).length - 1;
  if (n === null) bad(`${p} is missing`); else if (n !== d.n) bad(`${p}: ${n} rows filed, ${d.n} in the database`); else auditOk++;
}
console.log(`  ${auditOk} of ${dbDays.length} day-files match`);

const files = await walk(MAIN, "");
const stray = files.filter((p) => !(`${p.split("/")[0]}/` in Object.fromEntries([...EXPECT].map((f) => [f, 1]))));
if (stray.length) bad(`${stray.length} file(s) outside the named folders: ${stray.slice(0, 5).join(", ")}`);
const wrongFormat = files.filter((p) => !/^(call-recordings)\//.test(p) && !p.endsWith(".csv"));
if (wrongFormat.length) bad(`${wrongFormat.length} file(s) that are not spreadsheets: ${wrongFormat.slice(0, 5).join(", ")}`);
const owned = new Set(calls.flatMap((c) => [c.recording_path, c.transcript_path].filter(Boolean)));
const orphans = files.filter((p) => /^(call-recordings|call-transcripts)\//.test(p) && !owned.has(p));
if (orphans.length) bad(`${orphans.length} recording/transcript file(s) in Storage that no call points at: ${orphans.slice(0, 3).join(", ")}`);
console.log(`  ${files.length} files in the customers' bucket.`);

console.log(`\nAdmin bucket: ${ADMIN || "(not set)"}`);
if (!ADMIN) bad("SUPABASE_ADMIN_BUCKET is not set, so the admin's records are not filed anywhere");
else {
  const adminFiles = await walk(ADMIN, "");
  const folders = new Set(Object.values(ADMIN_FOLDERS));
  for (const p of adminFiles) { if (!folders.has(p.split("/")[0])) bad(`unexpected admin file: ${p}`); if (!p.endsWith(".csv")) bad(`admin file is not a spreadsheet: ${p}`); }
  const users = (await systemQuery("SELECT count(*)::int AS n, count(DISTINCT email)::int AS e FROM users")).rows[0];
  const members = (await systemQuery("SELECT count(*)::int AS n FROM memberships")).rows[0].n;
  const orgs = (await systemQuery("SELECT count(*)::int AS n FROM organizations")).rows[0].n;
  const admins = (await systemQuery("SELECT count(*)::int AS n FROM admins")).rows[0].n;
  const rows = async (p) => { const t = await get(ADMIN, p); return t === null ? null : table(t).length - 1; };
  for (const [p, want, label] of [["people/all-users.csv", members, "memberships"], ["people/all-emails.csv", users.e, "unique e-mails"], ["people/unique-users.csv", users.n, "users"],
    ["people/admin-accounts.csv", admins, "admin accounts"], ["organizations/organizations-and-plans.csv", orgs, "organizations"]]) {
    const n = await rows(p);
    if (n === null) bad(`${p} is missing from the admin bucket`); else if (n !== want) bad(`${p} has ${n} rows, the database has ${want} ${label}`); else console.log(`  ${p}: ${n} rows, matches ${label}`);
  }
  const secrets = (await systemQuery("SELECT salt, hash FROM users UNION ALL SELECT salt, hash FROM admins")).rows;
  for (const p of adminFiles) { const t = (await get(ADMIN, p)) ?? ""; for (const { salt, hash } of secrets) if (t.includes(salt) || t.includes(hash)) bad(`${p} contains a password hash or salt`); }
  const nreq = (await systemQuery("SELECT count(*)::int AS n FROM org_requests")).rows[0].n;
  const filedReq = (await Promise.all(adminFiles.filter((p) => p.startsWith("customer-requests/")).map(async (p) => table(await get(ADMIN, p)).length - 1))).reduce((a, b) => a + b, 0);
  if (filedReq !== nreq) console.log(`  note: ${filedReq} of ${nreq} requests are filed (older days are only refiled while recent)`);
  console.log(`  ${adminFiles.length} files in the admin bucket.`);
}
console.log(problems.length ? `\n${problems.length} PROBLEM(S) FOUND.` : "\nEverything checked is saved, in the right place, and matches the database.");
await pool.end();
process.exit(problems.length ? 1 : 0);
