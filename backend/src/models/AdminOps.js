// What an admin can see and change across every organization. Reads are by the database owner role
// (asSystem), so each query names the organization it means and takes it as a parameter, never in the text.
// Nothing here returns a password hash, a session token or a provider credential.
import * as Requests from "./Requests.js";
import { asSystem, systemQuery } from "../db/pool.js";
import { config } from "../config/env.js";
import { scryptHashAsync, sha256, token } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { pageNumber } from "../utils/paging.js";
import { randomBytes } from "node:crypto";
import { cleanText } from "../utils/text.js";
import { ASSIGNABLE } from "./permissions.js";
import * as Billing from "./Billing.js";
import * as OrgSettings from "./OrgSettings.js";

const ORG = /^org_[0-9a-f]{12}$/;
const USER = /^u_[0-9a-f]{12}$/;
export const PAGE_SIZES = [10, 25, 50];
export const ORG_STATUSES = ["active", "pending", "expired", "suspended", "cancelled", "none", "unmetered", "requested"];
export const TOPUP_STATUSES = ["pending", "paid", "rejected", "cancelled"];
const iso = (d) => (d ? new Date(d).toISOString() : null);
const like = (q) => `%${String(q).replace(/[\\%_]/g, "\\$&")}%`;

function sizeOf(raw) {
  const size = Number(raw ?? 10);
  if (!PAGE_SIZES.includes(size)) throw new ValidationError(`per_page must be one of ${PAGE_SIZES.join(", ")}`);
  return size;
}
function termOf(q) {
  if (q === undefined || q === "") return null;
  if (typeof q !== "string") throw new ValidationError("q must be text");
  return q.trim().slice(0, 100) || null;
}
const orgId = (id) => { if (!ORG.test(String(id))) throw new NotFoundError("organization"); return String(id); };
const userId = (id) => { if (!USER.test(String(id))) throw new NotFoundError("person"); return String(id); };

export async function overview() {
  const [orgs, users, money, minutes, topups, requests, calls] = await Promise.all([
    systemQuery(`SELECT (SELECT count(*) FROM organizations)::int AS total,
        count(*) FILTER (WHERE s.status = 'active')::int AS active, count(*) FILTER (WHERE s.status = 'pending')::int AS pending,
        count(*) FILTER (WHERE s.status = 'expired')::int AS expired, count(*) FILTER (WHERE s.status = 'suspended')::int AS suspended,
        count(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled, count(*) FILTER (WHERE s.unmetered)::int AS unmetered,
        count(*) FILTER (WHERE s.requested_plan_id IS NOT NULL)::int AS requested, count(*)::int AS with_plan
      FROM subscriptions s`),
    systemQuery("SELECT count(*)::int AS total, count(*) FILTER (WHERE disabled_at IS NOT NULL)::int AS disabled FROM users"),
    systemQuery(`SELECT coalesce(sum((terms->>'price_paise')::bigint), 0) AS mrr FROM subscriptions WHERE status = 'active' AND NOT unmetered`),
    systemQuery(`SELECT coalesce(-sum(minutes) FILTER (WHERE kind = 'usage' AND at > now() - interval '30 days'), 0)::int AS used_30d,
        coalesce(sum(minutes) FILTER (WHERE kind = 'topup' AND at > now() - interval '30 days'), 0)::int AS topped_up_30d FROM minute_ledger`),
    systemQuery(`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
        coalesce(sum(amount_paise) FILTER (WHERE status = 'pending'), 0) AS pending_paise,
        coalesce(sum(amount_paise) FILTER (WHERE status = 'paid' AND decided_at > now() - interval '30 days'), 0) AS paid_30d_paise FROM topups`),
    systemQuery("SELECT count(*)::int AS open FROM org_requests WHERE status = 'open'"),
    systemQuery(`SELECT count(*) FILTER (WHERE (started_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today,
        count(*) FILTER (WHERE ended_at IS NULL AND (status IS NULL OR status = 'ringing') AND has_transcript AND started_at > now() - interval '20 minutes')::int AS live
      FROM calls WHERE started_at > now() - interval '2 days'`),
  ]);
  const o = orgs.rows[0];
  return {
    orgs: { total: o.total, active: o.active, pending: o.pending, expired: o.expired, suspended: o.suspended, cancelled: o.cancelled,
      unmetered: o.unmetered, requested: o.requested, no_plan: o.total - o.with_plan },
    users: users.rows[0],
    revenue: { mrr_paise: Number(money.rows[0].mrr) },
    minutes: minutes.rows[0],
    topups: { pending: topups.rows[0].pending, pending_paise: Number(topups.rows[0].pending_paise), paid_30d_paise: Number(topups.rows[0].paid_30d_paise) },
    requests: requests.rows[0],
    calls: calls.rows[0],
  };
}

/** Everything waiting for a decision, waiting requests and top-ups together, newest first, one page at a time. */
export async function notifications({ page = 1, perPage = 10 } = {}) {
  const size = [10, 25, 50].includes(Number(perPage)) ? Number(perPage) : 10;
  const p = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
  const feed = `SELECT * FROM (
      SELECT r.id, CASE r.kind WHEN 'plan_change' THEN 'plan_change' ELSE 'request' END AS kind, r.org_id, o.name AS org_name, r.created_by AS who,
        r.created_at AS at, coalesce(np.name, '') AS plan_name, r.message AS detail, 0::int AS minutes, 0::bigint AS amount_paise, coalesce(cp.name, '') AS current_plan
      FROM org_requests r JOIN organizations o ON o.id = r.org_id LEFT JOIN plans np ON np.id = r.plan_id
        LEFT JOIN subscriptions s ON s.org_id = r.org_id LEFT JOIN plans cp ON cp.id = s.plan_id WHERE r.status = 'open'
      UNION ALL
      SELECT t.id, 'topup', t.org_id, o.name, t.requested_by, t.created_at, '', t.reference, t.minutes, t.amount_paise, ''
      FROM topups t JOIN organizations o ON o.id = t.org_id WHERE t.status = 'pending') f`;
  const { rows: [{ n }] } = await systemQuery(`SELECT count(*)::int AS n FROM (${feed}) c`);
  const { rows } = await systemQuery(`${feed} ORDER BY at DESC, id DESC LIMIT ${size} OFFSET ${(p - 1) * size}`);
  const text = (r) => r.kind === "topup" ? `Top-up of ${r.minutes} minutes, ${r.detail}, is waiting for payment to be confirmed`
    : r.kind === "plan_change" ? `Wants to move${r.current_plan ? ` from ${r.current_plan}` : ""} to ${r.plan_name}${r.detail ? `: ${r.detail}` : ""}` : r.detail;
  return { total: n, page: p, per_page: size, items: rows.map((r) => ({ id: r.id, kind: r.kind, org_id: r.org_id, org_name: r.org_name, who: r.who,
    at: iso(r.at), text: text(r), link: r.kind === "topup" ? "/topups" : `/orgs/${r.org_id}` })) };
}

export async function listOrgs({ q, status, page, perPage }) {
  const size = sizeOf(perPage);
  const n = pageNumber(page);
  const term = termOf(q);
  if (status !== undefined && status !== "" && !ORG_STATUSES.includes(status)) throw new ValidationError(`status must be one of: ${ORG_STATUSES.join(", ")}`);
  const params = [term ? like(term) : null, term];
  let statusSql = "TRUE";
  if (status === "none") statusSql = "s.org_id IS NULL";
  else if (status === "unmetered") statusSql = "s.unmetered";
  else if (status === "requested") statusSql = "s.requested_plan_id IS NOT NULL";
  else if (status) { statusSql = "s.status = $3"; params.push(status); }
  const where = `($1::text IS NULL OR o.name ILIKE $1 OR o.id = $2
      OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND (u.email ILIKE $1 OR u.name ILIKE $1)))
    AND ${statusSql}`;
  const total = (await systemQuery(`SELECT count(*)::int AS n FROM organizations o LEFT JOIN subscriptions s ON s.org_id = o.id WHERE ${where}`, params)).rows[0].n;
  const { rows } = await systemQuery(
    `SELECT o.id, o.name, o.created_at,
       (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'admin' ORDER BY m.created_at LIMIT 1) AS owner_email,
       (SELECT count(*)::int FROM memberships m WHERE m.org_id = o.id) AS members,
       s.plan_id, p.name AS plan_name, s.status, s.unmetered, s.balance_minutes, s.period_end, s.requested_plan_id,
       (SELECT count(*)::int FROM org_requests q WHERE q.org_id = o.id AND q.status = 'open') AS open_requests,
       (SELECT count(*)::int FROM calls c WHERE c.org_id = o.id AND c.started_at > now() - interval '30 days') AS calls_30d
     FROM organizations o LEFT JOIN subscriptions s ON s.org_id = o.id LEFT JOIN plans p ON p.id = s.plan_id
     WHERE ${where} ORDER BY o.created_at DESC, o.id LIMIT ${size} OFFSET ${(n - 1) * size}`, params);
  return { total, page: n, per_page: size, orgs: rows.map((r) => ({ id: r.id, name: r.name, created_at: iso(r.created_at), owner_email: r.owner_email,
    members: r.members, plan_id: r.plan_id, plan_name: r.plan_name, status: r.status, unmetered: Boolean(r.unmetered),
    balance_minutes: r.status ? Number(r.balance_minutes) : null, period_end: iso(r.period_end), requested_plan_id: r.requested_plan_id, open_requests: r.open_requests, calls_30d: r.calls_30d })) };
}

const requestShape = Requests.shape;
const maskNumber = (n) => (n ? `XXXXXX${String(n).replace(/\D/g, "").slice(-4)}` : null);

/** One organization, whole. */
export async function orgDetail(id) {
  const org = orgId(id);
  const { rows: [o] } = await systemQuery("SELECT id, name, created_at FROM organizations WHERE id = $1", [org]);
  if (!o) throw new NotFoundError("organization");
  const [members, sub, ledger, topups, calls, counts, settings, requests] = await Promise.all([
    systemQuery(`SELECT u.id, u.name, u.email, u.created_at, u.last_login_at, u.disabled_at, m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 ORDER BY CASE m.role WHEN 'admin' THEN 0 ELSE 1 END, m.created_at`, [org]),
    Billing.get(org),
    systemQuery("SELECT id, at, kind, minutes, call_id, actor, note FROM minute_ledger WHERE org_id = $1 ORDER BY at DESC, id DESC LIMIT 20", [org]),
    systemQuery("SELECT * FROM topups WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20", [org]),
    systemQuery(`SELECT call_id, peer, direction, status, started_at, duration_secs FROM calls WHERE org_id = $1
      ORDER BY started_at DESC NULLS LAST LIMIT 10`, [org]),
    systemQuery(`SELECT (SELECT count(*)::int FROM agents WHERE org_id = $1) AS agents, (SELECT count(*)::int FROM contacts WHERE org_id = $1) AS contacts,
        (SELECT count(*)::int FROM phone_numbers WHERE org_id = $1) AS numbers,
        (SELECT count(*)::int FROM calls WHERE org_id = $1 AND started_at > now() - interval '30 days') AS calls_30d,
        (SELECT coalesce(-sum(minutes), 0)::int FROM minute_ledger WHERE org_id = $1 AND kind = 'usage' AND at > now() - interval '30 days') AS minutes_30d`, [org]),
    OrgSettings.get(org).catch(() => null),
    systemQuery(`SELECT r.*, np.name AS plan_name FROM org_requests r LEFT JOIN plans np ON np.id = r.plan_id WHERE r.org_id = $1 AND r.status <> 'replaced'
      ORDER BY (r.status = 'open') DESC, r.created_at DESC, r.id DESC LIMIT 20`, [org]),
  ]);
  return {
    org: { id: o.id, name: o.name, created_at: iso(o.created_at) },
    members: members.rows.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, created_at: iso(m.created_at),
      last_login_at: iso(m.last_login_at), disabled: Boolean(m.disabled_at) })),
    subscription: sub,
    ledger: ledger.rows.map((l) => ({ id: Number(l.id), at: iso(l.at), kind: l.kind, minutes: l.minutes, call_id: l.call_id, actor: l.actor, note: l.note })),
    topups: topups.rows.map((t) => ({ id: t.id, minutes: t.minutes, amount_paise: Number(t.amount_paise), rate_paise: t.rate_paise, status: t.status,
      reference: t.reference, note: t.note, created_at: iso(t.created_at), decided_at: iso(t.decided_at) })),
    calls: calls.rows.map((c) => ({ call_id: c.call_id, peer: maskNumber(c.peer), direction: c.direction, status: c.status, started_at: iso(c.started_at), duration_secs: c.duration_secs })),
    counts: counts.rows[0],
    settings,
    requests: requests.rows.map((r) => ({ ...requestShape(r), plan_name: r.plan_name ?? null })),
  };
}

export async function renameOrg(id, name) {
  const org = orgId(id);
  if (typeof name !== "string") throw new ValidationError("the name must be text");
  const clean = cleanText(name, 80, "name");
  const { rowCount } = await systemQuery("UPDATE organizations SET name = $2 WHERE id = $1", [org, clean]);
  if (!rowCount) throw new NotFoundError("organization");
  return { id: org, name: clean };
}

export async function setOrgSettings(id, changes) {
  const org = orgId(id);
  if (!(await systemQuery("SELECT 1 FROM organizations WHERE id = $1", [org])).rowCount) throw new NotFoundError("organization");
  return OrgSettings.update(org, changes);
}

// --- people --------------------------------------------------------------------------------------

export async function listUsers({ q, page, perPage }) {
  const size = sizeOf(perPage);
  const n = pageNumber(page);
  const term = termOf(q);
  const where = "($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1 OR u.id = $2)";
  const params = [term ? like(term) : null, term];
  const total = (await systemQuery(`SELECT count(*)::int AS n FROM users u WHERE ${where}`, params)).rows[0].n;
  const { rows } = await systemQuery(
    `SELECT u.id, u.name, u.email, u.created_at, u.last_login_at, u.disabled_at,
       coalesce((SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'role', m.role) ORDER BY m.created_at)
         FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = u.id), '[]'::json) AS orgs
     FROM users u WHERE ${where} ORDER BY u.created_at DESC, u.id LIMIT ${size} OFFSET ${(n - 1) * size}`, params);
  return { total, page: n, per_page: size, users: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, created_at: iso(u.created_at),
    last_login_at: iso(u.last_login_at), disabled: Boolean(u.disabled_at), orgs: u.orgs })) };
}

/** Switch an account off or on. Off ends every session at once and refuses the next sign-in. */
export async function setUserDisabled(id, disabled) {
  const uid = userId(id);
  const out = await asSystem(async (db) => {
    const { rows } = await db.query("UPDATE users SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) ELSE NULL END WHERE id = $1 RETURNING id, name, email",
      [uid, disabled]);
    if (!rows[0]) throw new NotFoundError("person");
    if (disabled) await db.query("DELETE FROM sessions WHERE user_id = $1", [uid]);
    return rows[0];
  });
  return { id: out.id, name: out.name, email: out.email, disabled };
}

/** A one-time temporary password, shown once to the admin. Every session of that person ends. */
export async function resetPassword(id) {
  const uid = userId(id);
  const temporary = token(12);
  const salt = randomBytes(16);
  const hash = await scryptHashAsync(temporary, salt);
  const out = await asSystem(async (db) => {
    const { rows } = await db.query("UPDATE users SET salt = $2, hash = $3 WHERE id = $1 RETURNING id, name, email", [uid, salt.toString("hex"), hash]);
    if (!rows[0]) throw new NotFoundError("person");
    await db.query("DELETE FROM sessions WHERE user_id = $1", [uid]);
    await db.query("DELETE FROM login_failures WHERE key LIKE $1", [`%${rows[0].email}%`]);
    return rows[0];
  });
  return { id: out.id, name: out.name, email: out.email, temporary_password: temporary };
}

/** A person's role in one organization. An organization always keeps at least one admin. */
export async function changeRole(orgIdRaw, userIdRaw, role) {
  const org = orgId(orgIdRaw);
  const uid = userId(userIdRaw);
  if (!ASSIGNABLE.includes(role)) throw new ValidationError(`role must be one of: ${ASSIGNABLE.join(", ")}`);
  return asSystem(async (db) => {
    const { rows: [m] } = await db.query(`SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.user_id = $2 FOR UPDATE OF m`, [org, uid]);
    if (!m) throw new NotFoundError("person in this organization");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`roles:${org}`]);
    await db.query("UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2", [org, uid, role]);
    if (!(await db.query("SELECT 1 FROM memberships WHERE org_id = $1 AND role = 'admin'", [org])).rowCount) {
      throw new ValidationError("an organization must always keep at least one admin");
    }
    return { id: m.id, name: m.name, role };
  });
}

export async function removeMember(orgIdRaw, userIdRaw) {
  const org = orgId(orgIdRaw);
  const uid = userId(userIdRaw);
  return asSystem(async (db) => {
    const { rows: [m] } = await db.query(`SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.user_id = $2 FOR UPDATE OF m`, [org, uid]);
    if (!m) throw new NotFoundError("person in this organization");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`roles:${org}`]);
    await db.query("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2", [org, uid]);
    if (!(await db.query("SELECT 1 FROM memberships WHERE org_id = $1 AND role = 'admin'", [org])).rowCount) {
      throw new ValidationError("an organization must always keep at least one admin");
    }
    await db.query("DELETE FROM sessions WHERE user_id = $1 AND org_id = $2", [uid, org]);
    const rest = await db.query("SELECT org_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1", [uid]);
    if (!rest.rowCount) await db.query("DELETE FROM users WHERE id = $1", [uid]);
    else await db.query("UPDATE users SET org_id = $1 WHERE id = $2 AND org_id = $3", [rest.rows[0].org_id, uid, org]);
    return { id: m.id, name: m.name };
  });
}

// --- support access ----------------------------------------------------------------------------

const SUPPORT_LINK_SECS = 60;

/** A one-use link, good for a minute, that signs the admin into the Studio as this person. */
export async function startSupport(orgIdRaw, userIdRaw, adminEmail) {
  const org = orgId(orgIdRaw);
  if (typeof userIdRaw !== "string" || !USER.test(userIdRaw)) throw new ValidationError("say which person to open the Studio as");
  const raw = token(32);
  const who = await asSystem(async (db) => {
    const { rows: [m] } = await db.query(`SELECT u.id, u.name, u.disabled_at FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.user_id = $2`, [org, userIdRaw]);
    if (!m) throw new NotFoundError("person in this organization");
    if (m.disabled_at) throw new ValidationError("that account is switched off; switch it on first");
    await db.query("DELETE FROM impersonations WHERE expires_at < now() - interval '1 day'");
    await db.query("INSERT INTO impersonations (token_hash, user_id, org_id, admin_email, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
      [sha256(raw), m.id, org, adminEmail, SUPPORT_LINK_SECS]);
    return m;
  });
  return { url: `${config.studioUrl.replace(/\/+$/, "")}/support#token=${raw}`, person: who.name, expires_in: SUPPORT_LINK_SECS };
}

// --- top-ups, plans, the record --------------------------------------------------------------------

export async function listTopups({ status, page, perPage, org }) {
  const size = sizeOf(perPage);
  const n = pageNumber(page);
  const only = org === undefined || org === "" ? null : orgId(org);
  if (status !== undefined && status !== "" && !TOPUP_STATUSES.includes(status)) throw new ValidationError(`status must be one of: ${TOPUP_STATUSES.join(", ")}`);
  const params = [status || null, only];
  const total = (await systemQuery("SELECT count(*)::int AS n FROM topups WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR org_id = $2)", params)).rows[0].n;
  const { rows } = await systemQuery(
    `SELECT t.*, o.name AS org_name, u.name AS requested_by_name FROM topups t JOIN organizations o ON o.id = t.org_id
       LEFT JOIN users u ON u.id = t.requested_by WHERE ($1::text IS NULL OR t.status = $1) AND ($2::text IS NULL OR t.org_id = $2)
     ORDER BY (t.status = 'pending') DESC, t.created_at DESC, t.id LIMIT ${size} OFFSET ${(n - 1) * size}`, params);
  return { total, page: n, per_page: size, topups: rows.map((t) => ({ id: t.id, org_id: t.org_id, org_name: t.org_name, requested_by: t.requested_by_name,
    minutes: t.minutes, rate_paise: t.rate_paise, amount_paise: Number(t.amount_paise), status: t.status, reference: t.reference, note: t.note,
    created_at: iso(t.created_at), decided_at: iso(t.decided_at), decided_by: t.decided_by })) };
}

/** One organization's minute ledger, a page at a time. */
export async function orgLedger(orgIdRaw, { page, perPage }) {
  const org = orgId(orgIdRaw);
  if (!(await systemQuery("SELECT 1 FROM organizations WHERE id = $1", [org])).rowCount) throw new NotFoundError("organization");
  return Billing.ledgerPage(org, { page, perPage });
}

/** One organization's calls, a page at a time, with the other party's number masked. */
export async function orgCalls(orgIdRaw, { page, perPage }) {
  const org = orgId(orgIdRaw);
  if (!(await systemQuery("SELECT 1 FROM organizations WHERE id = $1", [org])).rowCount) throw new NotFoundError("organization");
  const size = sizeOf(perPage);
  const n = pageNumber(page);
  const total = (await systemQuery("SELECT count(*)::int AS n FROM calls WHERE org_id = $1", [org])).rows[0].n;
  const { rows } = await systemQuery(`SELECT call_id, peer, direction, status, started_at, duration_secs FROM calls WHERE org_id = $1
    ORDER BY started_at DESC NULLS LAST, call_id LIMIT ${size} OFFSET ${(n - 1) * size}`, [org]);
  return { total, page: n, per_page: size, calls: rows.map((c) => ({ call_id: c.call_id, peer: maskNumber(c.peer), direction: c.direction, status: c.status,
    started_at: iso(c.started_at), duration_secs: c.duration_secs })) };
}

export async function auditPage({ page, perPage }) {
  const size = sizeOf(perPage);
  const n = pageNumber(page);
  const total = (await systemQuery("SELECT count(*)::int AS n FROM admin_audit")).rows[0].n;
  const { rows } = await systemQuery(`SELECT id, at, admin_email, action, org_id, target, detail FROM admin_audit
    ORDER BY at DESC, id DESC LIMIT ${size} OFFSET ${(n - 1) * size}`);
  return { total, page: n, per_page: size, entries: rows.map((r) => ({ id: Number(r.id), at: iso(r.at), admin_email: r.admin_email, action: r.action,
    org_id: r.org_id, target: r.target, detail: r.detail })) };
}

