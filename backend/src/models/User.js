// Accounts, organizations, sessions, device cookies, invites and the sign-in lockout.
//
// Signing up without an invite creates an organization, with you as its owner.
// An invite code (one live code per organization, single use, a week) joins
// that organization as a member. Passwords are kept only as scrypt hashes,
// sessions only as the SHA-256 of their token. A session ends after
// SESSION_SECS, or after IDLE_SECS unused.
//
// Lockout: wrong passwords from a browser that never signed in to the account
// count per email *and address*, so a stranger guessing locks out only
// themselves; a slower per-email ceiling catches guessing spread over many
// addresses. A browser that has signed in before carries a device cookie and
// has its own count (OWASP "device cookies"). Counts live in PostgreSQL.
import { randomBytes } from "node:crypto";
import { asSystem, inOrg, systemQuery } from "../db/pool.js";
import { hexId, safeEqual, scryptHashAsync, sha256, token } from "../utils/crypto.js";
import { AuthError, forbidden, NotFoundError, ValidationError } from "../utils/errors.js";

export const SESSION_SECS = 7 * 24 * 3600;
export const IDLE_SECS = 12 * 3600;
const TOUCH_SECS = 300; // last_seen_at is written at most this often
export const DEVICE_SECS = 365 * 24 * 3600;
const MAX_SESSIONS_PER_USER = 10;
const MAX_DEVICES_PER_USER = 10;
const LOCKOUTS = [
  { scope: "pair", max: 5, secs: 300 },    // one email from one address
  { scope: "email", max: 50, secs: 3600 }, // one email from anywhere (spread-out guessing)
];
const INVITE_SECS = 7 * 24 * 3600;
const MIN_PASSWORD = 8, MAX_PASSWORD = 200;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$/;
export const ROLES = ["owner", "admin", "member"];

const DUMMY_SALT = randomBytes(16);
const asToken = (raw) => (typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? raw : null);
const words = (raw) => String(raw ?? "").split(/\s+/).filter(Boolean).join(" ");

const USER_COLS = `u.id, u.name, u.email, u.company, u.role, u.created_at, u.seen_at, u.org_id, o.name AS org_name`;

export function publicUser(u) {
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return { id: u.id, name: u.name, email: u.email, company: u.company, role: u.role, org_id: u.org_id,
    org_name: u.org_name, created_at: iso(u.created_at), seen_at: iso(u.seen_at) };
}

export async function hasAccounts() {
  return (await systemQuery("SELECT EXISTS (SELECT 1 FROM users) AS any")).rows[0].any;
}

/** The organization's live invite ({code, expires} in Unix seconds), made fresh
 * when there is none, it expired or was used, or `renew` asks for one. */
export async function currentInvite(orgId, { renew = false } = {}) {
  return inOrg(orgId, async (db) => {
    if (!renew) {
      const { rows } = await db.query("SELECT code, expires_at FROM invites WHERE org_id = $1 AND expires_at > now()", [orgId]);
      if (rows[0]) return { code: rows[0].code, expires: rows[0].expires_at.getTime() / 1000 };
    }
    const { rows } = await db.query(
      `INSERT INTO invites (code, org_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
       ON CONFLICT (org_id) DO UPDATE SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at
       RETURNING code, expires_at`, [token(12), orgId, INVITE_SECS]);
    return { code: rows[0].code, expires: rows[0].expires_at.getTime() / 1000 };
  });
}

function checkSignUp(fields) {
  const name = words(fields.name);
  const email = String(fields.email ?? "").trim().toLowerCase();
  const password = String(fields.password ?? "");
  const organization = words(fields.organization ?? fields.company);
  if (!name || name.length > 80) throw new ValidationError("enter your name (up to 80 characters)");
  if (!EMAIL.test(email)) throw new ValidationError("enter a valid email address");
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new ValidationError(`the password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`);
  }
  if (!fields.invite && (!organization || organization.length > 80)) {
    throw new ValidationError("enter your organization's name (up to 80 characters)");
  }
  if (organization.length > 80) throw new ValidationError("the organization name is over 80 characters");
  return { name, email, password, organization };
}

export async function signUp(fields) {
  const { name, email, password, organization } = checkSignUp(fields);
  const salt = randomBytes(16);
  const hash = await scryptHashAsync(password, salt); // before the transaction: it is slow
  return asSystem(async (db) => {
    let orgId, role;
    if (fields.invite) {
      const { rows } = await db.query("DELETE FROM invites WHERE code = $1 AND expires_at > now() RETURNING org_id",
        [String(fields.invite).slice(0, 100)]);
      if (!rows[0]) throw new AuthError("That invite code is not valid. Codes work once, for a week; ask for a new one.", 403);
      orgId = rows[0].org_id;
      role = "member";
    } else {
      orgId = `org_${hexId()}`;
      role = "owner";
      await db.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, organization]);
    }
    const taken = await db.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (taken.rowCount) throw new ValidationError("an account with this email already exists; sign in");
    const id = `u_${hexId()}`;
    await db.query(`INSERT INTO users (id, name, email, company, role, salt, hash, org_id) VALUES ($1, $2, $3, '', $4, $5, $6, $7)`,
      [id, name, email, role, salt.toString("hex"), hash, orgId]);
    const { rows } = await db.query(`SELECT ${USER_COLS} FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`, [id]);
    return publicUser(rows[0]);
  });
}

/** The user, if the password is right; otherwise an AuthError. */
export async function checkPassword(email, password, device, ip) {
  email = String(email ?? "").trim().toLowerCase().slice(0, 300);
  password = String(password ?? "").slice(0, MAX_PASSWORD);
  device = asToken(device);
  return asSystem(async (db) => {
    const { rows } = await db.query(`SELECT u.*, o.name AS org_name FROM users u JOIN organizations o ON o.id = u.org_id
      WHERE u.email = $1`, [email]);
    const user = rows[0];
    const trusted = Boolean(user && device && (await db.query("SELECT 1 FROM devices WHERE token_hash = $1 AND user_id = $2",
      [sha256(device), user.id])).rowCount);
    const keys = trusted ? [{ key: `device:${sha256(device)}`, max: 5, secs: 300 }]
      : LOCKOUTS.map((l) => ({ ...l, key: l.scope === "pair" ? `pair:${email}|${ip}` : `email:${email}` }));
    for (const { key, max, secs } of keys) {
      const { rows: [{ n }] } = await db.query(
        "SELECT count(*)::int AS n FROM login_failures WHERE key = $1 AND at > now() - make_interval(secs => $2)", [key, secs]);
      if (n >= max) throw new AuthError("Too many wrong passwords. Try again in a few minutes.");
    }
    const attempt = await scryptHashAsync(password, user ? Buffer.from(user.salt, "hex") : DUMMY_SALT);
    if (!user || !safeEqual(attempt, user.hash)) {
      for (const { key } of keys) await db.query("INSERT INTO login_failures (key) VALUES ($1)", [key]);
      await db.query("DELETE FROM login_failures WHERE at < now() - interval '1 hour' AND key = ANY($1)", [keys.map((k) => k.key)]);
      return null;
    }
    await db.query("DELETE FROM login_failures WHERE key = ANY($1)", [keys.filter((k) => k.scope !== "email").map((k) => k.key)]);
    return publicUser(user);
  }).then((user) => {
    if (!user) throw new AuthError("That email and password do not match.");
    return user;
  });
}

export async function changePassword(userId, current, next) {
  next = String(next ?? "");
  if (next.length < MIN_PASSWORD || next.length > MAX_PASSWORD) {
    throw new ValidationError(`the new password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`);
  }
  const { rows: [user] } = await systemQuery("SELECT salt, hash FROM users WHERE id = $1", [userId]);
  const attempt = user && await scryptHashAsync(String(current ?? "").slice(0, MAX_PASSWORD), Buffer.from(user.salt, "hex"));
  if (!user || !safeEqual(attempt, user.hash)) throw new AuthError("Your current password is not right.");
  const salt = randomBytes(16);
  const hash = await scryptHashAsync(next, salt);
  await asSystem(async (db) => {
    await db.query("UPDATE users SET salt = $1, hash = $2 WHERE id = $3", [salt.toString("hex"), hash, userId]);
    await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  });
}

export async function startSession(userId) {
  const raw = token(32);
  await asSystem(async (db) => {
    await db.query("DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()", [userId]);
    await db.query(`DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id = $1
      ORDER BY expires_at DESC OFFSET $2)`, [userId, MAX_SESSIONS_PER_USER - 1]);
    await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))",
      [sha256(raw), userId, SESSION_SECS]);
  });
  return raw;
}

export async function forSessionToken(raw) {
  raw = asToken(raw);
  if (!raw) return null;
  return asSystem(async (db) => {
    const { rows } = await db.query(`SELECT ${USER_COLS}, s.last_seen_at FROM sessions s
      JOIN users u ON u.id = s.user_id JOIN organizations o ON o.id = u.org_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(secs => $2)`,
    [sha256(raw), IDLE_SECS]);
    if (!rows[0]) return null;
    if (Date.now() - rows[0].last_seen_at.getTime() > TOUCH_SECS * 1000) {
      await db.query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", [sha256(raw)]);
    }
    return publicUser(rows[0]);
  });
}

export async function endSession(raw) {
  raw = asToken(raw);
  if (raw) await systemQuery("DELETE FROM sessions WHERE token_hash = $1", [sha256(raw)]);
}

/** Every other browser signed in to this account is signed out. */
export async function endOtherSessions(userId, keepRaw) {
  await systemQuery("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [userId, sha256(String(keepRaw ?? ""))]);
}

export async function issueDevice(userId) {
  const raw = token(32);
  await asSystem(async (db) => {
    await db.query("INSERT INTO devices (token_hash, user_id) VALUES ($1, $2)", [sha256(raw), userId]);
    await db.query(`DELETE FROM devices WHERE token_hash IN (SELECT token_hash FROM devices WHERE user_id = $1
      ORDER BY created_at DESC OFFSET $2)`, [userId, MAX_DEVICES_PER_USER]);
  });
  return raw;
}

export async function knowsDevice(userId, raw) {
  raw = asToken(raw);
  if (!raw) return false;
  return (await systemQuery("SELECT 1 FROM devices WHERE token_hash = $1 AND user_id = $2", [sha256(raw), userId])).rowCount > 0;
}

export async function markSeen(orgId, userId, at) {
  await inOrg(orgId, (db) => db.query("UPDATE users SET seen_at = $1 WHERE id = $2 AND org_id = $3", [at, userId, orgId]));
}

/** Everyone in the organization, with when they were last active. */
export async function members(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT id, name, email, role, created_at FROM users WHERE org_id = $1
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at`, [orgId]));
  const active = rows.length ? (await systemQuery("SELECT user_id, max(last_seen_at) AS at FROM sessions WHERE user_id = ANY($1) GROUP BY user_id",
    [rows.map((u) => u.id)])).rows : [];
  const last = Object.fromEntries(active.map((a) => [a.user_id, a.at.toISOString()]));
  return rows.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at.toISOString(),
    last_active: last[u.id] ?? null }));
}

async function teammate(db, orgId, userId) {
  const { rows } = await db.query("SELECT id, name, role FROM users WHERE id = $1 AND org_id = $2 FOR UPDATE", [String(userId ?? ""), orgId]);
  if (!rows[0]) throw new NotFoundError("teammate");
  return rows[0];
}

/** The owner makes members admins and admins members. */
export async function changeRole(actor, userId, role) {
  if (actor.role !== "owner") throw forbidden("only the organization's owner can change roles");
  if (userId === actor.id) throw new ValidationError("you cannot change your own role");
  if (!["admin", "member"].includes(role)) throw new ValidationError("role must be admin or member");
  return inOrg(actor.org_id, async (db) => {
    const target = await teammate(db, actor.org_id, userId);
    if (target.role === "owner") throw forbidden("the owner's role cannot be changed");
    await db.query("UPDATE users SET role = $1 WHERE id = $2 AND org_id = $3", [role, target.id, actor.org_id]);
    return { id: target.id, name: target.name, role };
  });
}

/** Admins remove members; the owner removes anyone but themselves. Their sessions end with them. */
export async function removeMember(actor, userId) {
  if (userId === actor.id) throw new ValidationError("you cannot remove yourself");
  const target = await inOrg(actor.org_id, async (db) => {
    const t = await teammate(db, actor.org_id, userId);
    if (t.role === "owner" || (t.role === "admin" && actor.role !== "owner")) {
      throw forbidden("you can only remove people with a lower role than yours");
    }
    return t;
  });
  await asSystem((db) => db.query("DELETE FROM users WHERE id = $1 AND org_id = $2", [target.id, actor.org_id]));
  return target;
}
