// Accounts, organizations, sessions, device cookies, invites and the sign-in lockout.
//
// Signing up without an invite creates an organization, with you as its admin.
// An invite code (models/Invite.js: single use, a week, made for one role) joins
// that organization with exactly that role. Passwords are kept only as scrypt hashes,
// sessions only as the SHA-256 of their token. A session ends after
// SESSION_SECS, or after IDLE_SECS unused.
//
// Lockout: wrong passwords from a browser that never signed in to the account
// count per email *and address*, so a stranger guessing locks out only
// themselves; a slower per-email ceiling catches guessing spread over many
// addresses. A browser that has signed in before carries a device cookie and
// has its own count (OWASP "device cookies"). Counts live in PostgreSQL.
import { AVATARS } from "./avatars.js";
import { ASSIGNABLE, can, permissionsOf } from "./permissions.js";
import { summarize } from "./Billing.js";
import * as Invite from "./Invite.js";
import { randomBytes } from "node:crypto";
import { asSystem, systemQuery } from "../db/pool.js";
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
const MIN_PASSWORD = 8, MAX_PASSWORD = 200;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$/;

const DUMMY_SALT = randomBytes(16);
const asToken = (raw) => (typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? raw : null);
const words = (raw) => String(raw ?? "").split(/\s+/).filter(Boolean).join(" ");

// The person, and their role in the organization `m` (a membership) is for.
const USER_COLS = `u.id, u.name, u.email, u.company, m.role, u.created_at, u.seen_at, u.avatar, m.org_id, o.name AS org_name`;
export const MAX_ORGS = 20;

export function publicUser(u) {
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return { id: u.id, name: u.name, email: u.email, company: u.company, role: u.role, org_id: u.org_id,
    org_name: u.org_name, created_at: iso(u.created_at), seen_at: iso(u.seen_at), avatar: u.avatar ?? null,
    permissions: permissionsOf(u.role) };
}

export async function hasAccounts() {
  return (await systemQuery("SELECT EXISTS (SELECT 1 FROM users) AS any")).rows[0].any;
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

const BAD_INVITE = "That invite code is not valid. Codes work once, for a week; ask for a new one.";
/** An invite code is text. A list or object that merely holds one must not work (String() would flatten it). */
const wrongKind = (invite) => invite !== undefined && invite !== null && invite !== "" && typeof invite !== "string";

export async function signUp(fields) {
  if (wrongKind(fields?.invite)) throw new AuthError(BAD_INVITE, 403);
  const { name, email, password, organization } = checkSignUp(fields);
  const salt = randomBytes(16);
  const hash = await scryptHashAsync(password, salt); // before the transaction: it is slow
  return asSystem(async (db) => {
    let orgId, role, inviteRole = null;
    if (fields.invite) {
      const used = await Invite.consume(db, fields.invite);
      if (!used) throw new AuthError(BAD_INVITE, 403);
      orgId = used.org_id;
      inviteRole = used.role; // what the code was made for, never what the person asked for
      role = "member";
    } else {
      orgId = `org_${hexId()}`;
      role = "admin";
      await db.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, organization]);
    }
    const taken = await db.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (taken.rowCount) throw new ValidationError("an account with this email already exists; sign in");
    const id = `u_${hexId()}`;
    await db.query(`INSERT INTO users (id, name, email, company, role, salt, hash, org_id) VALUES ($1, $2, $3, '', $4, $5, $6, $7)`,
      [id, name, email, role, salt.toString("hex"), hash, orgId]);
    // The membership is made by a trigger from users.role; the code's own role replaces the default one.
    if (inviteRole) await db.query("UPDATE memberships SET role = $3 WHERE user_id = $1 AND org_id = $2", [id, orgId, inviteRole]);
    const { rows } = await db.query(`SELECT ${USER_COLS} FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
      JOIN organizations o ON o.id = m.org_id WHERE u.id = $1`, [id]);
    return publicUser(rows[0]);
  });
}

/** The user, if the password is right; otherwise an AuthError. */
export async function checkPassword(email, password, device, ip) {
  email = String(email ?? "").trim().toLowerCase().slice(0, 300);
  password = String(password ?? "").slice(0, MAX_PASSWORD);
  device = asToken(device);
  return asSystem(async (db) => {
    // Lands on the organization used last (users.org_id), or any other they are still in.
    const { rows } = await db.query(`SELECT u.id, u.name, u.email, u.company, u.created_at, u.seen_at, u.salt, u.hash, u.disabled_at,
        m.role, m.org_id, o.name AS org_name
      FROM users u JOIN memberships m ON m.user_id = u.id JOIN organizations o ON o.id = m.org_id
      WHERE u.email = $1 ORDER BY (m.org_id = u.org_id) DESC, m.created_at LIMIT 1`, [email]);
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
    // Said only once the password is right, so nobody can tell from the answer whether an address has an account.
    if (user.disabled_at) throw new AuthError("This account has been switched off. Contact Kaho AI.", 403);
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

export const SUPPORT_SECS = 2 * 3600;

/** A new session. `impersonatedBy` marks one opened by Kaho support from the admin site: short, and not a sign-in by the person. */
export async function startSession(userId, orgId = null, { impersonatedBy = null, secs = SESSION_SECS } = {}) {
  const raw = token(32);
  await asSystem(async (db) => {
    await db.query("DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()", [userId]);
    await db.query(`DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id = $1
      ORDER BY expires_at DESC OFFSET $2)`, [userId, MAX_SESSIONS_PER_USER - 1]);
    await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at, org_id, impersonated_by)
      VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5)`, [sha256(raw), userId, secs, orgId, impersonatedBy]);
    if (!impersonatedBy) await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
  });
  return raw;
}

/** Spend a support link: one use, inside its minute, for a person still in that organization with their account on. */
export async function consumeSupportToken(raw) {
  raw = asToken(raw);
  const refused = () => new AuthError("This support link is not valid, or it has expired.");
  if (!raw) throw refused();
  return asSystem(async (db) => {
    const { rows: [t] } = await db.query(`UPDATE impersonations SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, org_id, admin_email`, [sha256(raw)]);
    if (!t) throw refused();
    const { rows } = await db.query(`SELECT ${USER_COLS} FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = $2
      JOIN organizations o ON o.id = m.org_id WHERE u.id = $1 AND u.disabled_at IS NULL`, [t.user_id, t.org_id]);
    if (!rows[0]) throw refused();
    return { user: publicUser(rows[0]), adminEmail: t.admin_email };
  });
}

export async function forSessionToken(raw) {
  raw = asToken(raw);
  if (!raw) return null;
  return asSystem(async (db) => {
    // A session whose organization the person has since left signs them out.
    const { rows } = await db.query(`SELECT ${USER_COLS}, s.last_seen_at, s.impersonated_by,
        bs.status AS b_status, bs.unmetered AS b_unmetered, bs.balance_minutes AS b_balance, bs.period_end AS b_period_end,
        bs.terms AS b_terms, bs.plan_id AS b_plan_id, bp.name AS b_plan_name
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN memberships m ON m.user_id = u.id AND m.org_id = coalesce(s.org_id, u.org_id)
      JOIN organizations o ON o.id = m.org_id
      LEFT JOIN subscriptions bs ON bs.org_id = m.org_id
      LEFT JOIN plans bp ON bp.id = bs.plan_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(secs => $2)
        AND u.disabled_at IS NULL`,
    [sha256(raw), IDLE_SECS]);
    if (!rows[0]) return null;
    if (Date.now() - rows[0].last_seen_at.getTime() > TOUCH_SECS * 1000) {
      await db.query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", [sha256(raw)]);
    }
    const r = rows[0];
    const user = publicUser(r);
    // The plan comes with the session lookup, so deciding whether the Studio is open costs no extra query.
    user.billing = summarize(r.b_status ? { status: r.b_status, unmetered: r.b_unmetered, balance_minutes: r.b_balance,
      period_end: r.b_period_end, terms: r.b_terms, plan_id: r.b_plan_id, plan_name: r.b_plan_name } : null);
    // Kaho staff signed in from the admin site. Shown to the person, so it is never a secret; WHO is kept off the wire.
    user.support = Boolean(r.impersonated_by);
    Object.defineProperty(user, "support_by", { value: r.impersonated_by ?? null, enumerable: false });
    return user;
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
  await asSystem((db) => db.query(`UPDATE users SET seen_at = $1 WHERE id = $2
    AND EXISTS (SELECT 1 FROM memberships WHERE user_id = $2 AND org_id = $3)`, [at, userId, orgId]));
}

/** Everyone in the organization, with when they were last active. */
export async function members(orgId) {
  // People are visible across organizations only through their membership of this one.
  const { rows } = await asSystem((db) => db.query(`SELECT u.id, u.name, u.email, u.avatar, m.role, m.created_at
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1
    ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 WHEN 'builder' THEN 2
      WHEN 'operator' THEN 3 ELSE 4 END, m.created_at`, [orgId]));
  const active = rows.length ? (await systemQuery("SELECT user_id, max(last_seen_at) AS at FROM sessions WHERE user_id = ANY($1) GROUP BY user_id",
    [rows.map((u) => u.id)])).rows : [];
  const last = Object.fromEntries(active.map((a) => [a.user_id, a.at.toISOString()]));
  return rows.map((u) => ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar ?? null, role: u.role, created_at: u.created_at.toISOString(),
    last_active: last[u.id] ?? null }));
}

async function teammate(db, orgId, userId) {
  const { rows } = await db.query(`SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.user_id = $1 AND m.org_id = $2 FOR UPDATE OF m`, [String(userId ?? ""), orgId]);
  if (!rows[0]) throw new NotFoundError("teammate");
  return rows[0];
}

/** One admin at a time changes who is in charge, so two admins demoting each other at the same moment cannot
 * leave nobody in charge. The lock is held to the end of the transaction. */
async function lockOrganization(db, orgId) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`roles:${orgId}`]);
}
async function adminsLeft(db, orgId) {
  return (await db.query("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'admin'", [orgId])).rows[0].n;
}
const NEEDS_AN_ADMIN = "an organization must always keep at least one admin";

/** Give someone a role. An admin may give any role, including admin, to anyone but themselves: that, with the rule
 * that the last admin is never taken away, is what keeps someone in charge. */
export async function changeRole(actor, userId, role) {
  if (!can(actor.role, "team.roles")) throw forbidden("your role does not allow changing roles");
  if (userId === actor.id) throw new ValidationError("you cannot change your own role");
  if (typeof role !== "string" || !ASSIGNABLE.includes(role)) throw new ValidationError(`role must be one of: ${ASSIGNABLE.join(", ")}`);
  return asSystem(async (db) => {
    await lockOrganization(db, actor.org_id);
    const target = await teammate(db, actor.org_id, userId);
    await db.query("UPDATE memberships SET role = $1 WHERE user_id = $2 AND org_id = $3", [role, target.id, actor.org_id]);
    if (await adminsLeft(db, actor.org_id) < 1) throw new ValidationError(NEEDS_AN_ADMIN); // rolls the change back
    return { id: target.id, name: target.name, role };
  });
}

/** Admins remove people, other admins too, but never themselves. Their sessions end with them. */
export async function removeMember(actor, userId) {
  if (userId === actor.id) throw new ValidationError("you cannot remove yourself");
  return asSystem(async (db) => {
    await lockOrganization(db, actor.org_id);
    const t = await teammate(db, actor.org_id, userId);
    if (!can(actor.role, "team.manage")) throw forbidden("your role does not allow removing people");
    await db.query("DELETE FROM memberships WHERE user_id = $1 AND org_id = $2", [t.id, actor.org_id]);
    if (await adminsLeft(db, actor.org_id) < 1) throw new ValidationError(NEEDS_AN_ADMIN); // rolls the removal back
    await db.query("DELETE FROM sessions WHERE user_id = $1 AND org_id = $2", [t.id, actor.org_id]);
    // Their account goes too if this was their only organization; otherwise they land in another one.
    const rest = await db.query("SELECT org_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1", [t.id]);
    if (!rest.rowCount) await db.query("DELETE FROM users WHERE id = $1", [t.id]);
    else await db.query("UPDATE users SET org_id = $1 WHERE id = $2 AND org_id = $3", [rest.rows[0].org_id, t.id, actor.org_id]);
    return t;
  });
}

// --- one person, several organizations ---------------------------------------------

/** The organizations this person is in, with their role in each. */
export async function organizations(userId, currentOrgId) {
  const { rows } = await asSystem((db) => db.query(`SELECT o.id, o.name, m.role, o.created_at FROM memberships m
    JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY m.created_at, o.id`, [userId]));
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, current: r.id === currentOrgId }));
}

/** A new organization with this person as its admin: a separate environment with nothing in it yet. */
export async function createOrganization(userId, rawName) {
  const name = words(rawName);
  if (!name || name.length > 80) throw new ValidationError("give the organization a name (up to 80 characters)");
  return asSystem(async (db) => {
    const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM memberships WHERE user_id = $1", [userId]);
    if (n >= MAX_ORGS) throw new ValidationError(`you can be in at most ${MAX_ORGS} organizations`);
    const id = `org_${hexId()}`;
    await db.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [id, name]);
    await db.query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'admin')", [userId, id]);
    return { id, name, role: "admin" };
  });
}

/** Work in another of this person's organizations, in this browser; sign-ins land there next. */
export async function switchOrganization(userId, rawSession, orgId) {
  return asSystem(async (db) => {
    const { rows } = await db.query(`SELECT o.id, o.name, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.org_id = $2`, [userId, String(orgId ?? "")]);
    if (!rows[0]) throw new NotFoundError("organization");
    await db.query("UPDATE sessions SET org_id = $1 WHERE token_hash = $2 AND user_id = $3", [orgId, sha256(String(rawSession ?? "")), userId]);
    await db.query("UPDATE users SET org_id = $1 WHERE id = $2", [orgId, userId]);
    return rows[0];
  });
}

/** Join another organization with its invite code, while signed in, with the role the code was made for. */
export async function joinOrganization(userId, invite) {
  if (wrongKind(invite)) throw new AuthError(BAD_INVITE, 403);
  return asSystem(async (db) => {
    const used = await Invite.consume(db, invite);
    if (!used) throw new AuthError(BAD_INVITE, 403);
    const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM memberships WHERE user_id = $1", [userId]);
    if (n >= MAX_ORGS) throw new ValidationError(`you can be in at most ${MAX_ORGS} organizations`);
    await db.query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [userId, used.org_id, used.role]);
    return used.org_id;
  });
}

/** Choose (or clear) the icon shown for this person. Only one of AVATARS, or null. */
export async function setAvatar(userId, avatar) {
  if (avatar !== null && !AVATARS.includes(avatar)) throw new ValidationError("pick one of the icons offered");
  await asSystem((db) => db.query("UPDATE users SET avatar = $2 WHERE id = $1", [userId, avatar]));
  return avatar;
}
