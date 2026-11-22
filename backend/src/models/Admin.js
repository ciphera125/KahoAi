// The admin site's own accounts and sessions, apart from the Studio's.
//
// Who may have one is decided twice, and both must hold: the e-mail address must be on ADMIN_EMAILS
// (exactly: no aliases, no dots, no plus-addresses), and sign-up must present ADMIN_SIGNUP_CODE, because an
// e-mail address is not proof of who is typing it. With no code configured, nobody can sign up. The
// allowlist is checked again on every sign-in and every request, so taking an address off it ends that
// person's access at once. Passwords are scrypt hashes; sessions only the SHA-256 of their token.
import { randomBytes } from "node:crypto";
import { config } from "../config/env.js";
import { asSystem, systemQuery } from "../db/pool.js";
import { hexId, safeEqual, scryptHashAsync, sha256, token } from "../utils/crypto.js";
import { AuthError, forbidden, ValidationError } from "../utils/errors.js";

export const SESSION_SECS = 8 * 3600;
export const IDLE_SECS = 30 * 60;
const TOUCH_SECS = 60;
const MAX_SESSIONS = 5;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 200;
const LOCKOUTS = [
  { scope: "pair", max: 5, secs: 300 },    // one address from one place
  { scope: "email", max: 30, secs: 3600 }, // one address from anywhere
];
const DUMMY_SALT = randomBytes(16);
const NOT_AVAILABLE = "Admin sign-up is not available for these details.";
const NO_MATCH = "That e-mail and password do not match.";

const text = (v) => (typeof v === "string" ? v : "");
export const normalize = (email) => text(email).trim().toLowerCase();
/** Exactly on the list. Case is ignored; nothing else is. */
export const isAllowed = (email) => config.adminEmails.includes(normalize(email));
/** What the public sign-in page is told: sign-up is on AND some allowed address still has no account. Once everyone
 * allowed has one, the form has nothing left to give and the public address stops advertising it. */
export async function signupAdvertised() {
  if (!signupOpen()) return false;
  const { rows } = await systemQuery("SELECT lower(email) AS email FROM admins");
  const have = new Set(rows.map((r) => r.email));
  return config.adminEmails.some((e) => !have.has(normalize(e)));
}

export const signupOpen = () => typeof config.ADMIN_SIGNUP_CODE === "string" && config.ADMIN_SIGNUP_CODE.length >= 16;

const iso = (d) => (d ? new Date(d).toISOString() : null);
const shape = (a) => ({ id: a.id, email: a.email, name: a.name, created_at: iso(a.created_at), last_login_at: iso(a.last_login_at) });

/** One line in the admin record. Never fails what it records. */
export async function audit(adminEmail, action, { orgId = null, target = null, detail = "", ip = null } = {}) {
  const clean = (v, n) => String(v ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, n);
  await systemQuery("INSERT INTO admin_audit (admin_email, action, org_id, target, detail, ip) VALUES ($1, $2, $3, $4, $5, $6)",
    [clean(adminEmail, 120) || "unknown", clean(action, 40), orgId, target ? clean(target, 120) : null, clean(detail, 500), ip ? clean(ip, 64) : null]);
}

export async function signUp(fields, ip) {
  // The gate first, and the same answer whichever part of it failed. The code is compared even when the
  // address is wrong, so the time taken does not say which one it was.
  const codeOk = signupOpen() && typeof fields?.code === "string" && safeEqual(fields.code, config.ADMIN_SIGNUP_CODE);
  const allowed = typeof fields?.email === "string" && isAllowed(fields.email);
  if (!signupOpen() || !codeOk || !allowed) throw forbidden(NOT_AVAILABLE);
  const email = normalize(fields.email);
  const name = text(fields.name).split(/\s+/).filter(Boolean).join(" ");
  const password = text(fields.password);
  if (!name || name.length > 80) throw new ValidationError("enter your name (up to 80 characters)");
  if (typeof fields.password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new ValidationError(`the password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`);
  }
  const salt = randomBytes(16);
  const hash = await scryptHashAsync(password, salt);
  const admin = await asSystem(async (db) => {
    if ((await db.query("SELECT 1 FROM admins WHERE email = $1", [email])).rowCount) {
      throw new ValidationError("an admin account with this e-mail address already exists; sign in");
    }
    const { rows } = await db.query("INSERT INTO admins (id, email, name, salt, hash) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [`ad_${hexId()}`, email, name, salt.toString("hex"), hash]);
    return rows[0];
  });
  await audit(email, "auth.signup", { target: admin.id, ip }).catch(() => {});
  return shape(admin);
}

/** The admin, if the address is on the list and the password is right; otherwise an AuthError that says no more than that. */
export async function checkPassword(email, password, ip) {
  const address = normalize(email).slice(0, 300);
  const secret = text(password).slice(0, MAX_PASSWORD);
  const result = await asSystem(async (db) => {
    const { rows: [admin] } = await db.query("SELECT * FROM admins WHERE email = $1", [address]);
    const keys = LOCKOUTS.map((l) => ({ ...l, key: l.scope === "pair" ? `admin-pair:${address}|${ip}` : `admin-email:${address}` }));
    for (const { key, max, secs } of keys) {
      const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM login_failures WHERE key = $1 AND at > now() - make_interval(secs => $2)", [key, secs]);
      if (n >= max) return { locked: true };
    }
    const attempt = await scryptHashAsync(secret, admin ? Buffer.from(admin.salt, "hex") : DUMMY_SALT);
    const ok = admin && !admin.disabled_at && isAllowed(address) && safeEqual(attempt, admin.hash);
    if (!ok) {
      for (const { key } of keys) await db.query("INSERT INTO login_failures (key) VALUES ($1)", [key]);
      await db.query("DELETE FROM login_failures WHERE at < now() - interval '1 hour' AND key = ANY($1)", [keys.map((k) => k.key)]);
      return { failed: true };
    }
    await db.query("DELETE FROM login_failures WHERE key = $1", [keys[0].key]);
    return { admin };
  });
  if (result.locked) throw new AuthError("Too many wrong passwords. Try again in a few minutes.");
  if (result.failed) {
    await audit(address || "unknown", "auth.login_failed", { detail: "wrong e-mail or password", ip }).catch(() => {});
    throw new AuthError(NO_MATCH);
  }
  return shape(result.admin);
}

export async function startSession(adminId, ip) {
  const raw = token(32);
  await asSystem(async (db) => {
    await db.query("DELETE FROM admin_sessions WHERE admin_id = $1 AND expires_at <= now()", [adminId]);
    await db.query(`DELETE FROM admin_sessions WHERE token_hash IN (SELECT token_hash FROM admin_sessions WHERE admin_id = $1
      ORDER BY expires_at DESC OFFSET $2)`, [adminId, MAX_SESSIONS - 1]);
    await db.query("INSERT INTO admin_sessions (token_hash, admin_id, expires_at, ip) VALUES ($1, $2, now() + make_interval(secs => $3), $4)",
      [sha256(raw), adminId, SESSION_SECS, ip ? String(ip).slice(0, 64) : null]);
    await db.query("UPDATE admins SET last_login_at = now() WHERE id = $1", [adminId]);
  });
  return raw;
}

/** The admin behind a cookie, or null: unknown, expired, idle, switched off, or no longer on the list. */
export async function forSessionToken(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 200) return null;
  return asSystem(async (db) => {
    const { rows } = await db.query(`SELECT a.*, s.last_seen_at FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(secs => $2) AND a.disabled_at IS NULL`,
    [sha256(raw), IDLE_SECS]);
    const a = rows[0];
    if (!a || !isAllowed(a.email)) return null;
    if (Date.now() - a.last_seen_at.getTime() > TOUCH_SECS * 1000) {
      await db.query("UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1", [sha256(raw)]);
    }
    return shape(a);
  });
}

export async function endSession(raw) {
  if (typeof raw === "string" && raw && raw.length <= 200) await systemQuery("DELETE FROM admin_sessions WHERE token_hash = $1", [sha256(raw)]);
}
