// Billing: the rate card (plans), one subscription per organization, the minute wallet and top-ups.
//
// Money is whole paise and time whole minutes. A subscription copies its plan's terms when it starts
// (jsonb), so editing a plan never silently changes what a customer was sold; an admin edits the
// customer's own terms instead. The wallet is a ledger (minute_ledger) whose sum a trigger keeps in
// subscriptions.balance_minutes. A call is charged to its next whole minute, once, whoever reports it
// and however often. Nothing is credited for a request alone: a top-up is credited when Kaho confirms
// the payment (decideTopup), because no payment gateway is connected.
import * as Requests from "./Requests.js";
import { randomBytes } from "node:crypto";
import { config } from "../config/env.js";
import { asSystem, inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { HttpError, NotFoundError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import * as Activity from "./Activity.js";
import * as Audit from "./Audit.js";

export const MIN_TOPUP = 50;
export const MAX_TOPUP = 20000;
export const MAX_PENDING_TOPUPS = 5;
export const PACKS = [100, 250, 500, 1000, 2500];
export const MAX_ADJUST = 1_000_000;
const LIVE_CALL_MINUTES = 20; // the same meaning as BulkCall.LIVE_CALL_MINUTES
const RINGING_SECS = 60;
const DEFAULT_SIMULTANEOUS = 10;

/** Refused because of the plan, not because the request was wrong. `stage` lets the bulk runner pause instead of failing rows. */
export class BillingError extends HttpError {
  constructor(status, code, message) {
    super(status, message);
    this.code = code;
    this.stage = "billing";
  }
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);

/** "Rs 1,375" / "Rs 1,375.50" for an amount in paise. */
export function rupees(paise) {
  const whole = Number(paise) % 100 === 0;
  return `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(Number(paise) / 100)}`;
}
const count = (n) => new Intl.NumberFormat("en-IN").format(n);

// --- plans --------------------------------------------------------------------------------

const planShape = (r) => ({ id: r.id, name: r.name, sort: r.sort, custom: r.custom, highlighted: r.highlighted, active: r.active,
  price_paise: num(r.price_paise), minutes_included: num(r.minutes_included), approx_calls: num(r.approx_calls),
  rate_paise: num(r.rate_paise), rate_is_from: r.rate_is_from, extra_paise: num(r.extra_paise), simultaneous: num(r.simultaneous),
  log_days: num(r.log_days), support: r.support, languages: r.languages });

export async function listPlans({ all = false } = {}) {
  const { rows } = await asSystem((db) => db.query(`SELECT * FROM plans ${all ? "" : "WHERE active"} ORDER BY sort, id`));
  return rows.map(planShape);
}

export async function getPlan(id) {
  const { rows } = await asSystem((db) => db.query("SELECT * FROM plans WHERE id = $1", [String(id ?? "").slice(0, 40)]));
  if (!rows[0]) throw new ValidationError("choose one of the plans on the rate card");
  return planShape(rows[0]);
}

// What a customer's terms may hold, with the words a person would use for each.
const NUMBER_TERMS = {
  price_paise: ["the monthly price (price_paise)", 0, 1_000_000_000],
  minutes_included: ["the minutes included (minutes_included)", 0, 1_000_000],
  approx_calls: ["the approximate number of calls (approx_calls)", 0, 1_000_000],
  rate_paise: ["the rate per minute (rate_paise)", 0, 100_000],
  extra_paise: ["the price of an extra minute (extra_paise)", 0, 100_000],
  simultaneous: ["the simultaneous calls (simultaneous)", 1, 100],
  log_days: ["the days call logs are kept (log_days)", 1, 3650],
};
const TEXT_TERMS = { support: 80, languages: 80 };
const REQUIRED_TERMS = ["price_paise", "minutes_included", "rate_paise", "extra_paise", "simultaneous", "log_days"];

/** Terms an admin typed: whole numbers in range, short text, nothing we do not know. Returns only what was given. */
export function checkTerms(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("the terms must be an object");
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (NUMBER_TERMS[key]) {
      const [label, lo, hi] = NUMBER_TERMS[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < lo || value > hi) {
        throw new ValidationError(`${label} must be a whole number from ${count(lo)} to ${count(hi)}`);
      }
      out[key] = value;
    } else if (TEXT_TERMS[key]) {
      if (typeof value !== "string" || value.trim().length > TEXT_TERMS[key]) throw new ValidationError(`${key} must be text of at most ${TEXT_TERMS[key]} characters`);
      out[key] = value.trim();
    } else {
      throw new ValidationError(`unknown term '${String(key).slice(0, 40)}'`);
    }
  }
  return out;
}

const snapshotOf = (plan) => Object.fromEntries(Object.keys({ ...NUMBER_TERMS, ...TEXT_TERMS })
  .filter((k) => plan[k] !== null && plan[k] !== undefined).map((k) => [k, plan[k]]));

function checkComplete(terms, plan) {
  const missing = REQUIRED_TERMS.filter((k) => terms[k] === undefined);
  if (missing.length) throw new ValidationError(`${plan.name} needs its terms set before it can start: ${missing.join(", ")}`);
}

/** Admin: change the rate card itself (what the next customer is sold). Existing customers keep their terms. */
export async function updatePlan(id, changes, { adminEmail } = {}) {
  const before = await getPlan(id);
  const next = { ...before };
  for (const [k, v] of Object.entries(changes ?? {})) {
    if (k === "name") {
      if (typeof v !== "string" || !v.trim() || v.trim().length > 40) throw new ValidationError("a plan's name is 1 to 40 characters");
      next.name = v.trim();
    } else if (["highlighted", "active", "rate_is_from"].includes(k)) {
      if (typeof v !== "boolean") throw new ValidationError(`${k} must be true or false`);
      next[k] = v;
    } else if (k === "sort") {
      if (!Number.isInteger(v) || v < 0 || v > 100) throw new ValidationError("sort must be a whole number from 0 to 100");
      next.sort = v;
    } else if (NUMBER_TERMS[k] || TEXT_TERMS[k]) {
      Object.assign(next, checkTerms({ [k]: v }));
    } else {
      throw new ValidationError(`unknown plan field '${String(k).slice(0, 40)}'`);
    }
  }
  await asSystem(async (db) => {
    if (next.highlighted) await db.query("UPDATE plans SET highlighted = false WHERE id <> $1", [id]);
    await db.query(`UPDATE plans SET name = $2, sort = $3, highlighted = $4, active = $5, price_paise = $6, minutes_included = $7,
        approx_calls = $8, rate_paise = $9, rate_is_from = $10, extra_paise = $11, simultaneous = $12, log_days = $13,
        support = $14, languages = $15, updated_at = now() WHERE id = $1`,
    [id, next.name, next.sort, next.highlighted, next.active, next.price_paise, next.minutes_included, next.approx_calls,
      next.rate_paise, next.rate_is_from, next.extra_paise, next.simultaneous, next.log_days, next.support, next.languages]);
  });
  logger.info({ plan: id, by: adminEmail ? "admin" : "system" }, "plan updated");
  return getPlan(id);
}

// --- what a subscription looks like to the Studio ---------------------------------------------

const LOCK_REASON = { pending: "subscription_pending", expired: "subscription_expired", suspended: "subscription_suspended", cancelled: "subscription_required" };
const LOCK_TEXT = {
  subscription_required: "Choose a plan to start using Kaho AI Studio.",
  subscription_pending: "Your plan is waiting for Kaho to confirm payment. The Studio opens as soon as it is confirmed.",
  subscription_expired: "Your plan has ended. Ask Kaho to renew it, and the Studio opens again.",
  subscription_suspended: "Your plan is suspended. Contact Kaho to have it switched back on.",
};
export const lockMessage = (reason) => LOCK_TEXT[reason] ?? LOCK_TEXT.subscription_required;

/**
 * What the Studio needs to know about an organization's plan, from one subscriptions row (or none).
 * Pure, so the session query can hand it over without a second round trip.
 */
export function summarize(row, now = new Date()) {
  if (!config.BILLING_ENFORCED) {
    return { enforced: false, locked: false, reason: null, status: row?.status ?? null, plan_id: row?.plan_id ?? null,
      plan_name: row?.plan_name ?? null, unmetered: Boolean(row?.unmetered), minutes_left: row ? Number(row.balance_minutes) : 0, level: "ok",
      period_end: iso(row?.period_end), simultaneous: num(row?.terms?.simultaneous) };
  }
  if (!row) return { enforced: true, locked: true, reason: "subscription_required", status: null, plan_id: null, plan_name: null,
    unmetered: false, minutes_left: 0, level: "empty", period_end: null, simultaneous: null };
  const ended = row.status === "active" && !row.unmetered && row.period_end && new Date(row.period_end) <= now;
  const status = ended ? "expired" : row.status;
  const reason = status === "active" ? null : (LOCK_REASON[status] ?? "subscription_required");
  const left = Number(row.balance_minutes);
  const included = num(row.terms?.minutes_included) ?? 0;
  const level = row.unmetered ? "ok" : left <= 0 ? "empty" : left <= Math.max(50, Math.round(included * 0.1)) ? "low" : "ok";
  return { enforced: true, locked: reason !== null, reason, status, plan_id: row.plan_id, plan_name: row.plan_name, unmetered: Boolean(row.unmetered),
    minutes_left: row.unmetered ? null : left, level, period_end: iso(row.period_end), simultaneous: num(row.terms?.simultaneous) };
}

const SUB_COLS = `s.org_id, s.plan_id, p.name AS plan_name, s.status, s.terms, s.unmetered, s.balance_minutes, s.period_start,
  s.period_end, s.requested_plan_id, s.request_note, s.chosen_at, s.activated_at, s.activated_by, s.note`;

const subShape = (r) => r && ({ org_id: r.org_id, plan_id: r.plan_id, plan_name: r.plan_name, status: r.status, terms: r.terms,
  unmetered: r.unmetered, balance_minutes: Number(r.balance_minutes), period_start: iso(r.period_start), period_end: iso(r.period_end),
  requested_plan_id: r.requested_plan_id, request_note: r.request_note, chosen_at: iso(r.chosen_at), activated_at: iso(r.activated_at),
  activated_by: r.activated_by, note: r.note });

/** The organization's subscription row, or null while it has never chosen a plan. */
export async function get(orgId) {
  const { rows } = await asSystem((db) => db.query(
    `SELECT ${SUB_COLS} FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.org_id = $1`, [orgId]));
  return subShape(rows[0]);
}

export async function summary(orgId) {
  const sub = await get(orgId);
  return summarize(sub ? { ...sub, balance_minutes: sub.balance_minutes } : null);
}

/** What a person sees on the Billing tab: the summary plus the terms, this period's use, the packs and how to pay. */
export async function overview(orgId) {
  const sub = await get(orgId);
  const s = summarize(sub);
  const out = { ...s, terms: sub?.terms ?? null, period_start: sub?.period_start ?? null, requested_plan_id: sub?.requested_plan_id ?? null,
    note: sub?.note ?? null, used_this_period: 0, packs: [], how_to_pay: config.BILLING_PAYMENT_INSTRUCTIONS ?? null,
    topup_limits: { min: MIN_TOPUP, max: MAX_TOPUP } };
  if (sub) {
    out.used_this_period = await usedSince(orgId, sub.period_start ?? new Date(Date.now() - 30 * 86400000));
    const rate = num(sub.terms?.extra_paise);
    if (rate !== null && !sub.unmetered) out.packs = PACKS.map((minutes) => ({ minutes, amount_paise: minutes * rate }));
  }
  return out;
}

async function usedSince(orgId, since) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    "SELECT coalesce(-sum(minutes), 0)::int AS n FROM minute_ledger WHERE org_id = $1 AND kind = 'usage' AND at >= $2", [orgId, since]));
  return rows[0].n;
}

// --- telling people ---------------------------------------------------------------------------

/** A notification for the whole team and a line in their audit log. Never fails the change itself. */
export async function tell(orgId, text, { actor = "Kaho AI", role = "staff", view = "billing" } = {}) {
  try { await Activity.add(orgId, "billing", text, { view, actor }); } catch (err) { logger.warn({ err: err.message }, "could not record a billing notification"); }
  try { await Audit.record(orgId, { actor, role, action: "billing", detail: text }); } catch (err) { logger.warn({ err: err.message }, "could not write the audit log"); }
}

// --- choosing and starting a plan ---------------------------------------------------------------

/** A person chooses a plan. Nothing starts until it is paid for, unless SUBSCRIPTION_AUTO_ACTIVATE is on. */
export async function subscribe(orgId, planId, { userName = "Someone" } = {}) {
  if (typeof planId !== "string" || !planId) throw new ValidationError("choose one of the plans on the rate card");
  const plan = await getPlan(planId);
  if (!plan.active) throw new ValidationError("that plan is not on offer any more");
  const current = await get(orgId);
  if (current?.status === "active" && summarize(current).status === "active") {
    throw new ValidationError("you already have a plan; ask Kaho to change it from Billing");
  }
  if (current?.status === "suspended") throw new BillingError(402, "subscription_suspended", lockMessage("subscription_suspended"));
  await asSystem((db) => db.query(
    `INSERT INTO subscriptions (org_id, plan_id, status, terms, unmetered, chosen_at, balance_minutes)
     VALUES ($1, $2, 'pending', $3, false, now(), 0)
     ON CONFLICT (org_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'pending', terms = EXCLUDED.terms,
       chosen_at = now(), requested_plan_id = NULL, request_note = NULL, updated_at = now()`,
    [orgId, plan.id, JSON.stringify(snapshotOf(plan))]));
  if (config.SUBSCRIPTION_AUTO_ACTIVATE && !plan.custom) {
    await assign(orgId, { planId: plan.id, adminEmail: "automatic", actor: "Kaho AI", quiet: true });
    await tell(orgId, `${userName} started the ${plan.name} plan. ${count(plan.minutes_included)} minutes added.`, { actor: userName, role: "admin" });
  } else {
    await tell(orgId, plan.custom
      ? `${userName} asked for the ${plan.name} plan. Kaho will be in touch to set it up.`
      : `${userName} chose the ${plan.name} plan. It starts when Kaho confirms payment.`, { actor: userName, role: "admin" });
  }
  return summary(orgId);
}

/** An active customer asks to move to another plan; an admin decides. */
export async function requestChange(orgId, planId, note, { userName = "Someone" } = {}) {
  if (typeof planId !== "string" || !planId) throw new ValidationError("choose one of the plans on the rate card");
  const plan = await getPlan(planId);
  const sub = await get(orgId);
  if (!sub) throw new ValidationError("choose a plan first");
  const text = typeof note === "string" ? note.trim().slice(0, 300) : "";
  await asSystem((db) => db.query("UPDATE subscriptions SET requested_plan_id = $2, request_note = $3, updated_at = now() WHERE org_id = $1",
    [orgId, plan.id, text || null]));
  await Requests.create(orgId, { kind: "plan_change", planId: plan.id, message: text, userName });
  await tell(orgId, `${userName} asked to move to the ${plan.name} plan. Kaho will be in touch.`, { actor: userName, role: "admin" });
  return summary(orgId);
}

/**
 * Admin: put an organization on a plan, with its own terms if they differ, and start it. The plan's
 * monthly minutes are added when it goes from not-active to active (or when `grantIncluded` says so).
 */
export async function assign(orgId, { planId, terms = {}, unmetered = false, grantIncluded, periodEnd = null,
  adminEmail, actor = "Kaho AI", quiet = false } = {}) {
  if (typeof planId !== "string" || !planId) throw new ValidationError("choose one of the plans on the rate card");
  const plan = await getPlan(planId);
  const given = checkTerms(terms);
  const merged = { ...snapshotOf(plan), ...given };
  if (!unmetered) checkComplete(merged, plan);
  else merged.simultaneous ??= DEFAULT_SIMULTANEOUS;
  let end = null;
  if (periodEnd !== null && periodEnd !== undefined && periodEnd !== "") {
    end = new Date(periodEnd);
    if (Number.isNaN(end.getTime()) || end <= new Date()) throw new ValidationError("the end of the period must be a date in the future");
  }
  const granted = await asSystem(async (db) => {
    const { rows: [org] } = await db.query("SELECT 1 FROM organizations WHERE id = $1", [orgId]);
    if (!org) throw new NotFoundError("organization");
    const { rows: [prior] } = await db.query("SELECT status, period_end, unmetered FROM subscriptions WHERE org_id = $1 FOR UPDATE", [orgId]);
    // "Already on a plan" means already counting minutes inside a month. An organization that was grandfathered with no
    // limit (or whose month somehow has no end) has neither, so putting it on a plan must start both.
    const wasMetered = prior?.status === "active" && !prior.unmetered && Boolean(prior.period_end);
    const grant = grantIncluded ?? !wasMetered;
    const startsMonth = grant || !wasMetered;
    await db.query(
      `INSERT INTO subscriptions (org_id, plan_id, status, terms, unmetered, period_start, period_end, activated_at, activated_by, requested_plan_id, request_note)
       VALUES ($1, $2, 'active', $3, $4, now(), $5, now(), $6, NULL, NULL)
       ON CONFLICT (org_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active', terms = EXCLUDED.terms, unmetered = EXCLUDED.unmetered,
         period_start = CASE WHEN $8 THEN now() ELSE subscriptions.period_start END,
         period_end = CASE WHEN $7::timestamptz IS NOT NULL THEN $7 WHEN $8 THEN EXCLUDED.period_end ELSE subscriptions.period_end END,
         activated_at = CASE WHEN $8 THEN now() ELSE subscriptions.activated_at END, activated_by = EXCLUDED.activated_by,
         requested_plan_id = NULL, request_note = NULL, renewal_notified_at = NULL, updated_at = now()`,
      [orgId, plan.id, JSON.stringify(merged), unmetered, unmetered ? null : (end ?? new Date(Date.now() + 31 * 86400000)), adminEmail ?? "admin",
        end, startsMonth]);
    await Requests.closePlanChange(db, orgId, plan.id, adminEmail ?? "admin");
    // The month ends one calendar month on, not 31 days on: set it in SQL where "1 month" is exact.
    if (!unmetered && !end && startsMonth) {
      await db.query("UPDATE subscriptions SET period_end = period_start + interval '1 month' WHERE org_id = $1", [orgId]);
    }
    const minutes = unmetered ? 0 : (merged.minutes_included ?? 0);
    if (grant && minutes > 0) {
      await db.query("INSERT INTO minute_ledger (org_id, kind, minutes, actor, note) VALUES ($1, 'plan', $2, $3, $4)",
        [orgId, minutes, actor, `${plan.name} plan: monthly minutes`]);
    }
    return grant && minutes > 0 ? minutes : 0;
  });
  if (!quiet) {
    await tell(orgId, unmetered
      ? `Your plan is now ${plan.name}, with no minute limit.`
      : `Your plan is now ${plan.name}.${granted ? ` ${count(granted)} minutes added.` : ""}`, { actor });
  }
  return get(orgId);
}

/** Admin: renew for another month: the next minutes are added and the period moves on. Unused minutes carry over. */
export async function renew(orgId, { adminEmail } = {}) {
  const sub = await get(orgId);
  if (!sub) throw new NotFoundError("subscription");
  if (sub.unmetered) throw new ValidationError("this organization has no minute limit, so there is nothing to renew");
  const minutes = num(sub.terms?.minutes_included) ?? 0;
  await asSystem(async (db) => {
    await db.query(
      `UPDATE subscriptions SET status = 'active', period_start = now(), activated_by = $2, renewal_notified_at = NULL, updated_at = now(),
         period_end = (CASE WHEN status = 'active' AND period_end > now() THEN period_end ELSE now() END) + interval '1 month'
       WHERE org_id = $1`, [orgId, adminEmail ?? "admin"]);
    if (minutes > 0) {
      await db.query("INSERT INTO minute_ledger (org_id, kind, minutes, actor, note) VALUES ($1, 'plan', $2, 'Kaho AI', $3)",
        [orgId, minutes, `${sub.plan_name} plan: renewed`]);
    }
  });
  const after = await get(orgId);
  await tell(orgId, `Your ${sub.plan_name} plan is renewed${minutes ? `, ${count(minutes)} minutes added` : ""}. It now runs to ${new Date(after.period_end).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}.`);
  return after;
}

/** Admin: change one customer's own terms (their rate, their extra-minute price, how many calls at once...). */
export async function setTerms(orgId, terms, { adminEmail } = {}) {
  const given = checkTerms(terms);
  if (!Object.keys(given).length) throw new ValidationError("say which terms to change");
  const sub = await get(orgId);
  if (!sub) throw new NotFoundError("subscription");
  const merged = { ...sub.terms, ...given };
  await asSystem((db) => db.query("UPDATE subscriptions SET terms = $2, updated_at = now() WHERE org_id = $1", [orgId, JSON.stringify(merged)]));
  await tell(orgId, `Kaho changed your plan terms: ${Object.keys(given).map((k) => k.replace(/_paise$/, "").replaceAll("_", " ")).join(", ")}.`);
  logger.info({ org: orgId, by: adminEmail ? "admin" : "system" }, "terms changed");
  return get(orgId);
}

/** Admin: suspend, cancel, or switch back on. Switching on never lengthens a plan that has run out: that is a renewal. */
export async function setStatus(orgId, status, { adminEmail } = {}) {
  if (!["suspended", "cancelled", "active"].includes(status)) throw new ValidationError("status must be suspended, cancelled or active");
  const sub = await get(orgId);
  if (!sub) throw new NotFoundError("subscription");
  let next = status;
  if (status === "active" && !sub.unmetered && sub.period_end && new Date(sub.period_end) <= new Date()) next = "expired";
  await asSystem((db) => db.query("UPDATE subscriptions SET status = $2, updated_at = now() WHERE org_id = $1", [orgId, next]));
  await tell(orgId, next === "suspended" ? "Your plan was suspended by Kaho. Contact Kaho to switch it back on."
    : next === "cancelled" ? "Your plan was cancelled."
      : next === "expired" ? "Your plan was switched back on but its month has ended. Ask Kaho to renew it."
        : "Your plan was switched back on.");
  logger.info({ org: orgId, status: next, by: adminEmail ? "admin" : "system" }, "subscription status changed");
  return get(orgId);
}

export async function setUnmetered(orgId, unmetered, { adminEmail } = {}) {
  if (typeof unmetered !== "boolean") throw new ValidationError("unmetered must be true or false");
  const sub = await get(orgId);
  if (!sub) throw new NotFoundError("subscription");
  await asSystem((db) => db.query("UPDATE subscriptions SET unmetered = $2, updated_at = now() WHERE org_id = $1", [orgId, unmetered]));
  await tell(orgId, unmetered ? "Your plan now has no minute limit." : "Your plan now counts minutes.");
  logger.info({ org: orgId, by: adminEmail ? "admin" : "system" }, "metering changed");
  return get(orgId);
}

// --- the wallet ---------------------------------------------------------------------------------

/** Add or remove minutes by hand, with who and why. Whole minutes, never zero, bounded. */
export async function adjust(orgId, minutes, { actor = "Kaho AI", note = "" } = {}) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || !Number.isInteger(minutes)) throw new ValidationError("minutes must be a whole number");
  if (minutes === 0) throw new ValidationError("choose how many minutes to add or remove; it cannot be zero");
  if (Math.abs(minutes) > MAX_ADJUST) throw new ValidationError(`at most ${count(MAX_ADJUST)} minutes at a time`);
  const reason = String(note ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 200);
  await asSystem(async (db) => {
    const { rows } = await db.query("SELECT 1 FROM subscriptions WHERE org_id = $1 FOR UPDATE", [orgId]);
    if (!rows[0]) throw new ValidationError("this organization has no plan yet");
    await db.query("INSERT INTO minute_ledger (org_id, kind, minutes, actor, note) VALUES ($1, 'adjust', $2, $3, $4)", [orgId, minutes, String(actor).slice(0, 80), reason]);
  });
  const now = (await get(orgId)).balance_minutes;
  await tell(orgId, minutes > 0
    ? `${count(minutes)} minutes added to your balance by Kaho. You now have ${count(now)}.${reason ? ` ${reason}` : ""}`
    : `${count(-minutes)} minutes removed from your balance by Kaho. You now have ${count(now)}.${reason ? ` ${reason}` : ""}`);
  return now;
}

export async function ledgerPage(orgId, { page = 1, perPage = 10 } = {}) {
  const size = [10, 25, 50].includes(Number(perPage)) ? Number(perPage) : 10;
  const p = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
  return inOrg(orgId, async (db) => {
    const total = (await db.query("SELECT count(*)::int AS n FROM minute_ledger WHERE org_id = $1", [orgId])).rows[0].n;
    const { rows } = await db.query(`SELECT id, at, kind, minutes, call_id, actor, note FROM minute_ledger WHERE org_id = $1
      ORDER BY at DESC, id DESC LIMIT $2 OFFSET $3`, [orgId, size, (p - 1) * size]);
    return { total, page: p, per_page: size, entries: rows.map((r) => ({ id: Number(r.id), at: r.at.toISOString(), kind: r.kind, minutes: r.minutes,
      call_id: r.call_id, actor: r.actor, note: r.note })) };
  });
}

/**
 * Charge a finished call to the wallet: its length, up to the next whole minute, once. Safe to call
 * again whenever the length is reported (the same line is corrected, never doubled). A call of an
 * organization without a metered plan costs nothing. Never throws: a call must be recorded regardless.
 */
export async function settleUsage(callId) {
  try {
    await asSystem(async (db) => {
      const { rows: [call] } = await db.query("SELECT org_id, duration_secs FROM calls WHERE call_id = $1", [callId]);
      const secs = Number(call?.duration_secs ?? 0);
      if (!call?.org_id || !(secs > 0)) return;
      const { rows: [sub] } = await db.query("SELECT unmetered FROM subscriptions WHERE org_id = $1", [call.org_id]);
      if (!sub || sub.unmetered) return;
      await db.query(
        `INSERT INTO minute_ledger (org_id, kind, minutes, call_id, actor, note) VALUES ($1, 'usage', $2, $3, 'call', '')
         ON CONFLICT (call_id) WHERE kind = 'usage' DO UPDATE SET minutes = EXCLUDED.minutes WHERE minute_ledger.minutes <> EXCLUDED.minutes`,
        [call.org_id, -Math.ceil(secs / 60), callId]);
    });
  } catch (err) {
    logger.warn({ err: String(err?.message ?? err).slice(0, 200), call: callId }, "could not charge a call's minutes");
  }
}

// --- what a plan limits ---------------------------------------------------------------------------

/** Calls this organization has on the line right now: begun with no end, or dialled in the last minute. */
export async function liveCalls(orgId) {
  const { rows } = await asSystem((db) => db.query(`SELECT count(*)::int AS n FROM calls c
    WHERE c.org_id = $1 AND c.ended_at IS NULL AND (c.status IS NULL OR c.status = 'ringing')
      AND ((c.has_transcript AND c.started_at > now() - make_interval(mins => $2))
        OR (NOT c.has_transcript AND c.status = 'ringing' AND c.started_at > now() - make_interval(secs => $3)))`,
  [orgId, LIVE_CALL_MINUTES, RINGING_SECS]));
  return rows[0].n;
}

/** Each organization's plan limits, in one query, for the bulk runner. Absent = no plan. */
export async function limitsFor(orgIds) {
  const out = new Map();
  if (!orgIds.length) return out;
  const { rows } = await asSystem((db) => db.query(
    "SELECT org_id, status, unmetered, balance_minutes, period_end, terms FROM subscriptions WHERE org_id = ANY($1)", [orgIds]));
  for (const r of rows) {
    const s = summarize({ ...r, plan_id: null, plan_name: null });
    out.set(r.org_id, { locked: s.locked, reason: s.reason, unmetered: s.unmetered, minutes_left: Number(r.balance_minutes),
      simultaneous: num(r.terms?.simultaneous) ?? DEFAULT_SIMULTANEOUS });
  }
  return out;
}

/** The runner's plain reason for pausing a run, or null when the plan lets it dial. */
export function pauseReason(limit) {
  if (!config.BILLING_ENFORCED) return null;
  if (!limit) return lockMessage("subscription_required");
  if (limit.locked) return lockMessage(limit.reason);
  if (!limit.unmetered && limit.minutes_left <= 0) return "No minutes left. Top up in Settings, then resume this bulk call.";
  return null;
}

/** Throws a BillingError unless this organization may place one more call right now. */
export async function assertCanCall(orgId) {
  if (!config.BILLING_ENFORCED) return;
  const sub = await get(orgId);
  const s = summarize(sub);
  if (s.locked) throw new BillingError(402, s.reason, lockMessage(s.reason));
  if (!s.unmetered && sub.balance_minutes <= 0) {
    throw new BillingError(402, "no_minutes", "You have no minutes left. Top up in Settings, under Billing, to place calls.");
  }
  const cap = num(sub.terms?.simultaneous) ?? DEFAULT_SIMULTANEOUS;
  if ((await liveCalls(orgId)) >= cap) {
    throw new BillingError(429, "too_many_calls", `Your plan allows ${cap} calls at once, and ${cap} are on the line. Try again when one ends.`);
  }
}

/**
 * Why a call for this organization must not be answered right now, or null. The phone server asks for every
 * call it is about to answer, so this is the one place "no minutes, no plan" reaches an inbound caller.
 * A short code, never anything about the organization.
 */
export async function blockReason(orgId) {
  if (!config.BILLING_ENFORCED) return null;
  const sub = await get(orgId);
  const s = summarize(sub);
  if (s.locked) return s.reason;
  if (!s.unmetered && sub.balance_minutes <= 0) return "no_minutes";
  return null;
}

/** The most calls at once this organization's plan allows (bulk calls may not ask for more). */
export async function simultaneousFor(orgId) {
  if (!config.BILLING_ENFORCED) return null;
  const sub = await get(orgId);
  return num(sub?.terms?.simultaneous) ?? DEFAULT_SIMULTANEOUS;
}

// --- top-ups --------------------------------------------------------------------------------------

const topupShape = (r) => ({ id: r.id, minutes: r.minutes, rate_paise: r.rate_paise, amount_paise: Number(r.amount_paise), status: r.status,
  reference: r.reference, note: r.note, created_at: iso(r.created_at), decided_at: iso(r.decided_at) });

function whole(raw) {
  const n = typeof raw === "string" && /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_TOPUP || n > MAX_TOPUP) {
    throw new ValidationError(`choose a whole number of minutes from ${count(MIN_TOPUP)} to ${count(MAX_TOPUP)}`);
  }
  return n;
}

/** A request for minutes, priced at this customer's own extra-minute rate. Credited only when Kaho confirms payment. */
export async function createTopup(orgId, { userId, userName = "Someone", minutes }) {
  const n = whole(minutes);
  const sub = await get(orgId);
  const s = summarize(sub);
  if (s.locked) throw new BillingError(402, s.reason, lockMessage(s.reason));
  if (s.unmetered) throw new ValidationError("your organization has no minute limit, so there is nothing to top up");
  const rate = num(sub.terms?.extra_paise);
  if (rate === null) throw new ValidationError("no price for extra minutes is set on your plan yet; contact Kaho");
  let created;
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    const reference = `KAHO-${randomBytes(4).toString("hex").toUpperCase()}`;
    created = await inOrg(orgId, async (db) => {
      const { rows: [{ pending }] } = await db.query("SELECT count(*)::int AS pending FROM topups WHERE org_id = $1 AND status = 'pending'", [orgId]);
      if (pending >= MAX_PENDING_TOPUPS) {
        throw new HttpError(429, `You already have ${MAX_PENDING_TOPUPS} top-ups waiting to be confirmed. Wait for them, or withdraw one.`);
      }
      const { rows } = await db.query(
        `INSERT INTO topups (id, org_id, requested_by, minutes, rate_paise, amount_paise, reference)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (reference) DO NOTHING RETURNING *`,
        [`tp_${hexId()}`, orgId, String(userId ?? "").slice(0, 80), n, rate, n * rate, reference]);
      return rows[0] ?? null;
    });
  }
  if (!created) throw new HttpError(503, "could not make a reference for the top-up; try again");
  await tell(orgId, `${userName} asked for a top-up of ${count(n)} minutes (${rupees(n * rate)}). It is added when Kaho confirms payment. Reference ${created.reference}.`,
    { actor: userName, role: "admin" });
  return { ...topupShape(created), how_to_pay: config.BILLING_PAYMENT_INSTRUCTIONS ?? "Kaho will contact you with the payment details." };
}

export async function listTopups(orgId) {
  const { rows } = await inOrg(orgId, (db) => db.query("SELECT * FROM topups WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100", [orgId]));
  return rows.map(topupShape);
}

/** The team withdraws a request that has not been confirmed. */
export async function cancelTopup(orgId, id, { userName = "Someone" } = {}) {
  if (!/^tp_[0-9a-f]{12}$/.test(String(id))) throw new NotFoundError("top-up request");
  const done = await inOrg(orgId, async (db) => {
    const { rows } = await db.query(
      "UPDATE topups SET status = 'cancelled', decided_at = now(), decided_by = 'requester' WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING *", [id, orgId]);
    if (rows[0]) return rows[0];
    const exists = await db.query("SELECT status FROM topups WHERE id = $1 AND org_id = $2", [id, orgId]);
    if (!exists.rowCount) throw new NotFoundError("top-up request");
    throw new ValidationError("only a top-up that is still waiting can be withdrawn");
  });
  await tell(orgId, `${userName} withdrew the top-up of ${count(done.minutes)} minutes.`, { actor: userName, role: "admin" });
  return topupShape(done);
}

/**
 * Kaho confirms (or declines) a payment. Atomic: the request is claimed by an UPDATE that only matches
 * a waiting one, and the credit is written in the same transaction, so a double click or two admins
 * at once can never credit twice.
 */
export async function decideTopup(id, { approve, adminEmail, note = "" }) {
  if (!/^tp_[0-9a-f]{12}$/.test(String(id))) throw new NotFoundError("top-up request");
  const reason = String(note ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 300);
  const done = await asSystem(async (db) => {
    const { rows } = await db.query(
      `UPDATE topups SET status = $2, decided_at = now(), decided_by = $3, note = $4 WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, approve ? "paid" : "rejected", String(adminEmail ?? "admin").slice(0, 120), reason || null]);
    if (!rows[0]) {
      const exists = await db.query("SELECT status FROM topups WHERE id = $1", [id]);
      if (!exists.rowCount) throw new NotFoundError("top-up request");
      throw new ValidationError(`this top-up was already ${exists.rows[0].status}`);
    }
    if (approve) {
      await db.query("INSERT INTO minute_ledger (org_id, kind, minutes, topup_id, actor, note) VALUES ($1, 'topup', $2, $3, 'Kaho AI', $4)",
        [rows[0].org_id, rows[0].minutes, id, `Top-up ${rows[0].reference}`]);
    }
    return rows[0];
  });
  if (approve) {
    const now = (await get(done.org_id))?.balance_minutes ?? 0;
    await tell(done.org_id, `${count(done.minutes)} minutes added to your balance (top-up ${done.reference}). You now have ${count(now)} minutes.`);
  } else {
    await tell(done.org_id, `Your top-up of ${count(done.minutes)} minutes (${done.reference}) was not confirmed.${reason ? ` ${reason}` : ""}`);
  }
  return topupShape(done);
}

// --- the month turning over -------------------------------------------------------------------------

/** Ends plans whose month is over, and warns three days before. Each happens once. Never touches an unmetered organization. */
export async function expireDue(now = new Date()) {
  const expired = [];
  const reminded = [];
  const ended = await asSystem((db) => db.query(
    "UPDATE subscriptions SET status = 'expired', updated_at = now() WHERE status = 'active' AND NOT unmetered AND period_end <= $1 RETURNING org_id", [now]));
  for (const { org_id: org } of ended.rows) {
    expired.push(org);
    await tell(org, "Your plan has ended. Ask Kaho to renew it so calls and the Studio keep working.");
  }
  const soon = await asSystem((db) => db.query(
    `UPDATE subscriptions SET renewal_notified_at = now() WHERE status = 'active' AND NOT unmetered AND period_end > $1
       AND period_end <= $1::timestamptz + interval '3 days' AND (renewal_notified_at IS NULL OR renewal_notified_at < period_start)
     RETURNING org_id, period_end`, [now]));
  for (const r of soon.rows) {
    reminded.push(r.org_id);
    await tell(r.org_id, `Your plan ends on ${new Date(r.period_end).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}. Ask Kaho to renew it so nothing stops.`);
  }
  return { expired, reminded };
}
