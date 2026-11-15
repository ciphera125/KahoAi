// Moves the platform's Storage to the new layout (2026-11-15): new bucket names, spreadsheets only, and a separate admin bucket.
// Supabase cannot rename a bucket, so this makes the new ones and COPIES into them. It never deletes anything:
// the old bucket stays exactly as it was until you remove it yourself, after verify_storage.mjs is clean.
//
//   node scripts/move_storage.mjs --old call-recordings --dry-run     what it would do
//   node scripts/move_storage.mjs --old call-recordings               do it
//
// Reads SUPABASE_RECORDINGS_BUCKET (the NEW customers' bucket) and SUPABASE_ADMIN_BUCKET from backend/.env.
// Steps: make both buckets if missing; copy each recording, checking its size; only then point the database at the
// copies; write every transcript again as a spreadsheet; refile every record and the admin's records as spreadsheets.
import "dotenv/config";
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? null : (args[i + 1]?.startsWith("--") ? true : args[i + 1] ?? true); };
const OLD = flag("old"), DRY = args.includes("--dry-run");
await import("../src/app.js");
const { systemQuery, asSystem, pool } = await import("../src/db/pool.js");
const { config } = await import("../src/config/env.js");
const { FOLDERS } = await import("../src/services/archive.js");
const NEW = config.SUPABASE_RECORDINGS_BUCKET, ADMIN = config.SUPABASE_ADMIN_BUCKET;
if (!OLD || typeof OLD !== "string" || !NEW || !ADMIN) { console.log("Usage: --old <current bucket>; and SUPABASE_RECORDINGS_BUCKET (new) and SUPABASE_ADMIN_BUCKET must be set in backend/.env"); process.exit(1); }
if (OLD === NEW) { console.log("The old and the new bucket are the same: set the new name in backend/.env first."); process.exit(1); }

const base = `${config.SUPABASE_URL}/storage/v1`;
const H = { Authorization: `Bearer ${config.SUPABASE_SECRET_KEY}`, apikey: config.SUPABASE_SECRET_KEY, "Content-Type": "application/json" };
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const api = (path, body, method = "POST") => fetch(`${base}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
const ls = async (b, prefix) => (await (await api(`/object/list/${b}`, { prefix, limit: 1000 })).json());
const walk = async (b, prefix) => { const out = []; for (const o of await ls(b, prefix)) { const p = prefix ? `${prefix}/${o.name}` : o.name; if (o.id) out.push({ path: p, size: o.metadata?.size }); else out.push(...await walk(b, p)); } return out; };
const size = async (b, p) => { const r = await fetch(`${base}/object/${b}/${enc(p)}`, { method: "HEAD", headers: H }); return r.ok ? Number(r.headers.get("content-length")) : null; };
const say = (s) => console.log(s);

for (const [bucket, label] of [[NEW, "customers'"], [ADMIN, "admin"]]) {
  const exists = (await api(`/bucket/${encodeURIComponent(bucket)}`, null, "GET")).ok;
  if (exists) say(`The ${label} bucket ${bucket} exists.`);
  else if (DRY) say(`Would make the private ${label} bucket ${bucket}.`);
  else {
    const r = await api("/bucket", { id: bucket, name: bucket, public: false });
    if (!r.ok) { say(`Could not make ${bucket}: HTTP ${r.status}`); process.exit(1); }
    say(`Made the private ${label} bucket ${bucket}.`);
  }
}

// Recordings: the ones the database points at, plus audio still under the voice service's own name (YYYY/MM/<call>.opus).
const old = await walk(OLD, "");
const audio = old.filter((o) => /^(1-recordings|call-recordings)\//.test(o.path) || /^\d{4}\/\d{2}\/[^/]+\.(opus|wav)$/.test(o.path));
const target = (p) => p.replace(/^1-recordings\//, `${FOLDERS.recordings}/`);
say(`\n${old.length} files in ${OLD}; ${audio.length} are recordings to copy. The rest are records that are written again as spreadsheets.`);
let copied = 0, failed = 0;
for (const o of audio) {
  const to = target(o.path);
  if (DRY) { say(`  would copy ${o.path} -> ${NEW}/${to}`); continue; }
  const have = await size(NEW, to);
  const want = await size(OLD, o.path);
  if (have !== null && have === want) { copied++; continue; }
  const r = await api("/object/copy", { bucketId: OLD, sourceKey: o.path, destinationBucket: NEW, destinationKey: to });
  const after = r.ok ? await size(NEW, to) : null;
  if (after === null || after !== want) { failed++; say(`  PROBLEM: ${o.path} did not copy cleanly (HTTP ${r.status}, ${want} bytes there, ${after} here)`); } else copied++;
}
say(`  ${copied} recordings are in ${NEW} with the right size${failed ? `; ${failed} FAILED` : ""}.`);
if (DRY) { await pool.end(); process.exit(0); }
if (failed) { say("Stopping: nothing in the database was changed. Run it again."); await pool.end(); process.exit(1); }

// Only now does the database point at the copies.
const upd = await asSystem((db) => db.query(
  `UPDATE calls SET recording_path = regexp_replace(recording_path, '^1-recordings/', $1) WHERE recording_path LIKE '1-recordings/%'`, [`${FOLDERS.recordings}/`]));
say(`Database: ${upd.rowCount} recording paths now name ${FOLDERS.recordings}/.`);
await asSystem((db) => db.query("UPDATE calls SET transcript_path = NULL WHERE transcript_path IS NOT NULL AND transcript_path NOT LIKE $1", [`${FOLDERS.transcripts}/%.csv`]));

const { publishCallFiles } = await import("../src/services/callFiles.js");
const withWords = (await systemQuery("SELECT call_id FROM calls WHERE has_transcript ORDER BY started_at")).rows;
for (const { call_id: id } of withWords) await publishCallFiles(id);
say(`Transcripts: ${withWords.length} written as spreadsheets in ${FOLDERS.transcripts}/.`);
const { archiveOnce } = await import("../src/services/archive.js");
const { archiveAdmin } = await import("../src/services/archiveAdmin.js");
const a = await archiveOnce({ days: 4000 });
const b = await archiveAdmin({ days: 4000 });
say(`Records: ${a.filed} filed in ${NEW}${a.failed ? `, ${a.failed} refused` : ""}; ${b.filed} filed in ${ADMIN}${b.failed ? `, ${b.failed} refused` : ""}.`);
say(`\nNext: restart the Studio and the phone server so they use ${NEW}, then run node scripts/verify_storage.mjs.`);
say(`${OLD} has not been touched. Delete it yourself in Supabase once the check is clean.`);
await pool.end();
process.exit(failed || a.failed || b.failed ? 1 : 0);
