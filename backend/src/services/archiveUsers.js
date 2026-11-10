// Who uses the platform, filed in Supabase Storage in three plain spreadsheets:
//
//   3-users/users.csv                 every person in every organization: role, joined, last signed in
//   4-user-emails/emails.csv          every e-mail address, once
//   5-unique-users/unique-users.csv   every person once: e-mail, name, signed up, last signed in
//
// Passwords are NOT in these files and cannot be: only a salted scrypt hash is stored, and the readable
// password does not exist anywhere. A hash is a credential in its own right (it can be attacked offline),
// so it is never exported either. Session tokens and invite codes are not here. This is a whole-platform
// export for the person who runs the platform, so it is started only by the server's own timer, never
// by an organization's administrator.
import { systemQuery } from "../db/pool.js";
import { logger } from "../utils/logger.js";
import { putText, recordingsConfigured } from "./storage.js";

const cell = (value) => {
  const t = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; // a name cannot become a formula when opened in a spreadsheet
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
const sheet = (head, rows) => `${[head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
const day = (d) => {
  if (!d) return "";
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(d)).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute} IST`;
};
export const PASSWORD_NOTE = "Kept hashed. The readable password is not stored anywhere and cannot be exported.";

export async function usersExport() {
  const { rows: members } = await systemQuery(
    `SELECT u.name, u.email, o.name AS org, m.role, m.created_at AS joined, u.last_login_at
       FROM memberships m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.org_id
      ORDER BY u.email, o.name`);
  const { rows: people } = await systemQuery("SELECT name, email, created_at, last_login_at FROM users ORDER BY email");
  return {
    users: sheet(["Name", "Email", "Organization", "Role", "Joined", "Last signed in"],
      members.map((r) => [r.name, r.email, r.org, r.role, day(r.joined), day(r.last_login_at)])),
    emails: sheet(["Email"], people.map((r) => [r.email])),
    unique: sheet(["Email", "Name", "Signed up", "Last signed in", "Password"],
      people.map((r) => [r.email, r.name, day(r.created_at), day(r.last_login_at), PASSWORD_NOTE])),
  };
}

export const USER_FILES = { users: "3-users/users.csv", emails: "4-user-emails/emails.csv", unique: "5-unique-users/unique-users.csv" };

/** Never throws; says how many files were filed and how many Storage refused. */
export async function archiveUsers() {
  if (!recordingsConfigured()) return { filed: 0, failed: 0, skipped: true };
  let filed = 0;
  let failed = 0;
  try {
    const out = await usersExport();
    for (const [key, path] of Object.entries(USER_FILES)) (await putText(path, out[key])) ? filed++ : failed++;
  } catch (err) {
    failed = Object.keys(USER_FILES).length - filed;
    logger.error({ err: String(err?.message ?? err).slice(0, 200) }, "could not file the user lists");
  }
  if (failed) logger.warn({ failed }, "some user lists could not be filed in Storage");
  return { filed, failed };
}
