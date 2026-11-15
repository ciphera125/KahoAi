// Kaho staff's own records, in a bucket of their own (SUPABASE_ADMIN_BUCKET), apart from every customer's:
//
//   admin-activity/<year>/<month>/<day>.csv           everything an admin did, and who did it
//   organizations/organizations-and-plans.csv         every organization: its plan, status and minutes (a snapshot)
//   organizations/plans-and-rates.csv                 the rate card
//   customer-requests/<year>/<month>/<day>.csv        what customers asked Kaho for, and the answer
//   all-topups/<year>/<month>/<day>.csv               every top-up of every organization
//   people/admin-accounts.csv                         who has an admin login
//   people/all-users.csv, all-emails.csv, unique-users.csv   everyone on the platform (the lists that used to be 3 to 5)
//
// Spreadsheets only. No password, no hash, no session or setup code, no IP address. Days files are rewritten whole from
// the database (the record of truth) each pass, like the customers' records, so a failed pass is simply tried again.
import { systemQuery } from "../db/pool.js";
import { redactPII } from "../models/redact.js";
import { sheet, stamp } from "../utils/csv.js";
import { logger } from "../utils/logger.js";
import { ADMIN_FOLDERS, istDay } from "./archive.js";
import { usersExport } from "./archiveUsers.js";
import { adminConfigured, putCsv } from "./storage.js";
import { config } from "../config/env.js";

const DAY_MS = 86_400_000;
const yn = (v) => (v ? "yes" : "no");

async function daily(folder, head, fetchRows, line, now, days) {
  const first = istDay(new Date(now.getTime() - (days - 1) * DAY_MS));
  const rows = await fetchRows(new Date(`${first}T00:00:00+05:30`));
  const byDay = new Map();
  for (const r of rows) { const d = istDay(new Date(r.at)); byDay.set(d, [...(byDay.get(d) ?? []), r]); }
  const files = [];
  for (const [d, items] of byDay) files.push([`${folder}/${d.slice(0, 4)}/${d.slice(5, 7)}/${d}.csv`, sheet(head, items.map(line))]);
  return files;
}

/** Never throws; says how many files were filed and how many Storage refused. */
export async function archiveAdmin({ days = 2, now = new Date() } = {}) {
  if (!adminConfigured()) return { filed: 0, failed: 0, skipped: true };
  const bucket = config.SUPABASE_ADMIN_BUCKET;
  const files = [];
  let failed = 0;
  try {
    files.push(...await daily(ADMIN_FOLDERS.activity, ["When (IST)", "Admin", "What they did", "Organization", "Who or what it was done to", "Detail"],
      async (since) => (await systemQuery("SELECT at, admin_email, action, org_id, target, detail FROM admin_audit WHERE at >= $1 ORDER BY at, id", [since])).rows,
      (r) => [stamp(r.at), r.admin_email, r.action, r.org_id, r.target, r.detail], now, days));
    files.push(...await daily(ADMIN_FOLDERS.requests, ["When (IST)", "Organization", "Kind", "Plan asked for", "What they wrote", "Status", "Answered by", "Answer", "Answered (IST)"],
      async (since) => (await systemQuery(`SELECT created_at AS at, org_id, kind, plan_id, message, status, decided_by, response, decided_at FROM org_requests WHERE created_at >= $1 ORDER BY created_at, id`, [since])).rows,
      (r) => [stamp(r.at), r.org_id, r.kind === "plan_change" ? "plan change" : "message", r.plan_id, redactPII(r.message ?? ""), r.status, r.decided_by, redactPII(r.response ?? ""), stamp(r.decided_at)], now, days));
    files.push(...await daily(ADMIN_FOLDERS.topups, ["When (IST)", "Organization", "Reference", "Minutes", "Price per minute (paise)", "Amount (paise)", "Status", "Decided (IST)", "Decided by"],
      async (since) => (await systemQuery("SELECT created_at AS at, org_id, reference, minutes, rate_paise, amount_paise, status, decided_at, decided_by FROM topups WHERE created_at >= $1 OR decided_at >= $1 ORDER BY created_at, id", [since])).rows,
      (r) => [stamp(r.at), r.org_id, r.reference, r.minutes, r.rate_paise, Number(r.amount_paise), r.status, stamp(r.decided_at), r.decided_by === "requester" ? "the customer" : r.decided_by], now, days));

    const orgs = (await systemQuery(
      `SELECT o.id, o.name, o.created_at, p.name AS plan, s.status, s.unmetered, s.balance_minutes, s.period_end,
          (SELECT count(*)::int FROM memberships m WHERE m.org_id = o.id) AS people,
          (SELECT count(*)::int FROM org_requests q WHERE q.org_id = o.id AND q.status = 'open') AS waiting
         FROM organizations o LEFT JOIN subscriptions s ON s.org_id = o.id LEFT JOIN plans p ON p.id = s.plan_id ORDER BY o.created_at, o.id`)).rows;
    files.push(["organizations/organizations-and-plans.csv", sheet(["Organization", "Name", "Created (IST)", "Plan", "Status", "No minute limit", "Minutes left", "Plan runs until (IST)", "People", "Requests waiting"],
      orgs.map((o) => [o.id, o.name, stamp(o.created_at), o.plan ?? "", o.status ?? "no plan", yn(o.unmetered), o.status ? o.balance_minutes : "", stamp(o.period_end), o.people, o.waiting]))]);
    const plans = (await systemQuery("SELECT * FROM plans ORDER BY sort, id").catch(() => systemQuery("SELECT * FROM plans ORDER BY id"))).rows;
    files.push(["organizations/plans-and-rates.csv", sheet(["Plan", "Name", "Price per month (paise)", "Minutes included", "Price per extra minute (paise)", "Calls at once", "On offer"],
      plans.map((p) => [p.id, p.name, p.price_paise ?? "", p.minutes_included ?? "", p.extra_paise ?? "", p.simultaneous ?? "", yn(p.active)]))]);
    const admins = (await systemQuery("SELECT name, email, created_at, last_login_at FROM admins ORDER BY created_at")).rows;
    files.push(["people/admin-accounts.csv", sheet(["Name", "E-mail", "Created", "Last signed in"], admins.map((a) => [a.name, a.email, stamp(a.created_at), stamp(a.last_login_at)]))]);
    const people = await usersExport();
    files.push(["people/all-users.csv", people.users], ["people/all-emails.csv", people.emails], ["people/unique-users.csv", people.unique]);
  } catch (err) {
    failed++;
    logger.error({ err: String(err?.message ?? err).slice(0, 200) }, "could not build the admin records");
  }
  let filed = 0;
  for (const [path, text] of files) (await putCsv(path, text, bucket)) ? filed++ : failed++;
  if (failed) logger.warn({ failed, filed }, "some admin records could not be filed in Storage");
  return { filed, failed };
}
