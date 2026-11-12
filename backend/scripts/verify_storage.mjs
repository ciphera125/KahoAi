// Read-only check that what the database says was saved is what Supabase Storage really holds, that
// it is in the right folder, and that no e-mail, phone number or name is in the text files.
//   node scripts/verify_storage.mjs        (from backend/, with backend/.env)
// Exit code 1 if anything is wrong. Prints counts, never the content of a file.
import "dotenv/config";
await import("../src/app.js");
const { systemQuery, pool } = await import("../src/db/pool.js");
const { config } = await import("../src/config/env.js");
const { redactPII } = await import("../src/models/redact.js");

const base = `${config.SUPABASE_URL}/storage/v1`;
const H = { Authorization: `Bearer ${config.SUPABASE_SECRET_KEY}`, apikey: config.SUPABASE_SECRET_KEY };
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const problems = [];
const bad = (what) => { problems.push(what); console.log(`  PROBLEM: ${what}`); };
const head = async (path) => { const r = await fetch(`${base}/object/${config.SUPABASE_RECORDINGS_BUCKET}/${enc(path)}`, { method: "HEAD", headers: H }); return r.ok ? Number(r.headers.get("content-length")) : null; };
const get = async (path) => { const r = await fetch(`${base}/object/${config.SUPABASE_RECORDINGS_BUCKET}/${enc(path)}`, { headers: H }); return r.ok ? await r.text() : null; };
const ls = async (prefix) => (await (await fetch(`${base}/object/list/${config.SUPABASE_RECORDINGS_BUCKET}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ prefix, limit: 1000 }) })).json());
const walk = async (prefix) => { const out = []; for (const o of await ls(prefix)) { const p = prefix ? `${prefix}/${o.name}` : o.name; if (o.id) out.push(p); else out.push(...await walk(p)); } return out; };
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;
const NUMBER = /\+?\d(?:[\s().-]?\d){8,}/;

console.log("Folders in the bucket:");
const top = (await ls("")).map((o) => o.name + (o.id ? "" : "/"));
console.log(`  ${top.join("  ")}`);
const EXPECT = new Set(["1-recordings/", "2-transcripts/", "3-users/", "4-user-emails/", "5-unique-users/", "6-audit-logs/", "7-tool-logs/", "8-builder-history/", "9-call-records/"]);
for (const f of top) if (!EXPECT.has(f)) bad(`unexpected item at the top of the bucket: ${f}`);
for (const f of EXPECT) if (!top.includes(f)) console.log(`  (empty so far: ${f})`);

console.log("\nCalls:");
const calls = (await systemQuery(`SELECT c.call_id, c.org_id, c.ended_at, c.has_transcript, c.recording_path, c.recording_bytes, c.transcript_path, c.archive_path, c.turns,
    (SELECT count(*)::int FROM call_events e WHERE e.call_id = c.call_id AND e.event = 'turn') AS turn_rows,
    (SELECT ct.name FROM contact_numbers cn JOIN contacts ct ON ct.id = cn.contact_id AND ct.org_id = cn.org_id WHERE cn.number = c.peer AND cn.org_id = c.org_id LIMIT 1) AS contact
  FROM calls c ORDER BY c.started_at`)).rows;
let rec = 0, tr = 0, arch = 0;
for (const c of calls) {
  const id = c.call_id.slice(0, 8);
  if (c.recording_path) {
    rec++;
    if (!c.recording_path.startsWith("1-recordings/")) bad(`${id}: recording is not in 1-recordings (${c.recording_path.split("/")[0]})`);
    const size = await head(c.recording_path);
    if (size === null) bad(`${id}: the recording is in the database but NOT in Storage`);
    else if (c.recording_bytes && Math.abs(size - c.recording_bytes) > 0) bad(`${id}: recording size differs (database ${c.recording_bytes}, Storage ${size})`);
    if (/[A-Za-z]{3,}-[A-Za-z]{3,}_/.test(c.recording_path.split("/").pop())) bad(`${id}: recording file name looks like it carries a name`);
  }
  if (c.has_transcript) {
    if (!c.transcript_path) { bad(`${id}: has a transcript but none is filed in 2-transcripts`); }
    else {
      tr++;
      if (!c.transcript_path.startsWith("2-transcripts/")) bad(`${id}: transcript is not in 2-transcripts`);
      const text = await get(c.transcript_path);
      if (text === null) bad(`${id}: the transcript is in the database but NOT in Storage`);
      else {
        const lines = text.split("\n").filter((l) => /^\[[^\]]+\] (Agent|Caller):/.test(l)).length;
        if (lines !== c.turn_rows) bad(`${id}: transcript has ${lines} lines, the database has ${c.turn_rows} turns`);
        if (EMAIL.test(text)) bad(`${id}: an e-mail address is in the transcript`);
        if (NUMBER.test(text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""))) bad(`${id}: a long number (phone?) is in the transcript`);
        for (const part of String(c.contact ?? "").split(/\s+/).filter((p) => p.length >= 3)) if (redactPII(text, { names: [part] }) !== text) bad(`${id}: the contact's name appears in the transcript`);
        if (/^Call with /m.test(text)) bad(`${id}: transcript header still names a caller`);
        if (redactPII(text, { names: [c.contact] }) !== text) bad(`${id}: the redaction would still change this transcript, so something private is in it`);
      }
    }
  } else if (c.ended_at && c.turns > 0) console.log(`  note ${id}: ended with ${c.turns} turns but no transcript flag`);
  if (c.ended_at) { if (c.archive_path) { arch++; if (await head(c.archive_path) === null) bad(`${id}: call record is in the database but NOT in Storage`); } else bad(`${id}: finished call has no record in 9-call-records yet`); }
}
console.log(`  ${calls.length} calls; ${rec} recordings, ${tr} transcripts, ${arch} call records, each checked in Storage`);

console.log("\nPeople:");
const users = (await systemQuery("SELECT count(*)::int AS n, count(DISTINCT email)::int AS e FROM users")).rows[0];
const members = (await systemQuery("SELECT count(*)::int AS n FROM memberships")).rows[0].n;
const rows = async (p) => { const t = await get(p); return t === null ? null : t.trim().split("\r\n").length - 1; };
for (const [p, want, label] of [["3-users/users.csv", members, "memberships"], ["4-user-emails/emails.csv", users.e, "unique e-mails"], ["5-unique-users/unique-users.csv", users.n, "users"]]) {
  const n = await rows(p);
  if (n === null) bad(`${p} is missing from Storage`); else if (n !== want) bad(`${p} has ${n} rows, the database has ${want} ${label}`); else console.log(`  ${p}: ${n} rows, matches ${label}`);
}
const stored = (await systemQuery("SELECT salt, hash FROM users")).rows;
for (const p of ["3-users/users.csv", "4-user-emails/emails.csv", "5-unique-users/unique-users.csv"]) { const t = (await get(p)) ?? ""; for (const { salt, hash } of stored) if (t.includes(salt) || t.includes(hash)) bad(`${p} contains a password hash or salt`); }
const nologin = (await systemQuery("SELECT count(*)::int AS n FROM users WHERE last_login_at IS NULL")).rows[0].n;
if (nologin) bad(`${nologin} user(s) have no last sign-in date`);

console.log("\nAudit logs (database rows against filed lines, per organization and day):");
const dbDays = (await systemQuery("SELECT org_id, to_char(at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day, count(*)::int AS n FROM audit_log GROUP BY 1, 2 ORDER BY 1, 2")).rows;
let auditOk = 0;
for (const d of dbDays) {
  const p = `6-audit-logs/${d.org_id}/${d.day.slice(0, 4)}/${d.day.slice(5, 7)}/${d.day}.jsonl`;
  const n = await rows(p) === null ? null : (await get(p)).trim().split("\n").length;
  if (n === null) bad(`${p} is missing`); else if (n !== d.n) bad(`${p}: ${n} lines filed, ${d.n} in the database`); else auditOk++;
}
console.log(`  ${auditOk} of ${dbDays.length} day-files match their database rows`);

const files = await walk("");
const stray = files.filter((p) => !/^(1-recordings|2-transcripts|3-users|4-user-emails|5-unique-users|6-audit-logs|7-tool-logs|8-builder-history|9-call-records)\//.test(p));
if (stray.length) bad(`${stray.length} file(s) outside the numbered folders: ${stray.slice(0, 5).join(", ")}`);
const owned = new Set(calls.flatMap((c) => [c.recording_path, c.transcript_path].filter(Boolean)));
const orphans = files.filter((p) => /^(1-recordings|2-transcripts)\//.test(p) && !owned.has(p));
if (orphans.length) bad(`${orphans.length} recording/transcript file(s) in Storage that no call points at: ${orphans.slice(0, 3).join(", ")}`);
console.log(`\n${files.length} files in Storage in all.`);
console.log(problems.length ? `\n${problems.length} PROBLEM(S) FOUND.` : "\nEverything checked is saved, in the right place, and matches the database.");
await pool.end();
process.exit(problems.length ? 1 : 0);
