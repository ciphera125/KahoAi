// The admin site. Every change is carried out by a model, written to the admin record with who did it and to
// whom, and told to the organization it touches. An admin's answer never holds a secret.
import * as Requests from "../models/Requests.js";
import * as Admin from "../models/Admin.js";
import * as AdminOps from "../models/AdminOps.js";
import * as Billing from "../models/Billing.js";
import { ADMIN_COOKIE, adminCookieOptions } from "../middleware/adminAuth.js";
import { platformHealth } from "../services/health.js";
import { ValidationError } from "../utils/errors.js";

const who = (req) => req.admin.email;
const record = (req, action, { orgId, target, detail } = {}) => Admin.audit(who(req), action, { orgId, target, detail, ip: req.ip });
const text = (v, what) => { if (typeof v !== "string" || !v) throw new ValidationError(`${what} must be text`); return v; };
const object = (v, what) => { if (v === undefined) return {}; if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ValidationError(`${what} must be an object`); return v; };

async function signedIn(req, res, admin) {
  res.cookie(ADMIN_COOKIE, await Admin.startSession(admin.id, req.ip), adminCookieOptions());
  res.json(admin);
}

export function state(_req, res) { res.json({ signup_open: Admin.signupOpen() }); }

export async function signUp(req, res) {
  const admin = await Admin.signUp(req.body ?? {}, req.ip);
  await signedIn(req, res, admin);
}

export async function signIn(req, res) {
  const admin = await Admin.checkPassword(req.body?.email, req.body?.password, req.ip);
  await record({ ...req, admin, ip: req.ip }, "auth.login", { target: admin.id }).catch(() => {});
  await signedIn(req, res, admin);
}

export async function signOut(req, res) {
  await Admin.endSession(req.cookies?.[ADMIN_COOKIE]);
  res.clearCookie(ADMIN_COOKIE, { path: "/api/admin" });
  res.json({ signed_out: true });
}

export const me = (req, res) => res.json(req.admin);
export async function overview(_req, res) { res.json(await AdminOps.overview()); }
export async function orgs(req, res) { res.json(await AdminOps.listOrgs({ q: req.query.q, status: req.query.status, page: req.query.page, perPage: req.query.per_page })); }
export async function orgLedger(req, res) { res.json(await AdminOps.orgLedger(req.params.orgId, { page: req.query.page, perPage: req.query.per_page })); }
export async function orgCalls(req, res) { res.json(await AdminOps.orgCalls(req.params.orgId, { page: req.query.page, perPage: req.query.per_page })); }
export async function org(req, res) { res.json(await AdminOps.orgDetail(req.params.orgId)); }

export async function rename(req, res) {
  const out = await AdminOps.renameOrg(req.params.orgId, req.body?.name);
  await record(req, "org.rename", { orgId: out.id, detail: `Renamed to ${out.name}` });
  res.json(out);
}

export async function settings(req, res) {
  const out = await AdminOps.setOrgSettings(req.params.orgId, object(req.body, "the settings"));
  await record(req, "org.settings", { orgId: req.params.orgId, detail: `Changed call rules: ${Object.keys(req.body).join(", ")}` });
  await Billing.tell(req.params.orgId, "Kaho changed your organization's call rules.");
  res.json(out);
}

export async function assignPlan(req, res) {
  const b = object(req.body, "the request");
  const out = await Billing.assign(req.params.orgId, { planId: text(b.plan_id, "plan_id"), terms: b.terms, unmetered: b.unmetered === true,
    grantIncluded: typeof b.grant_included === "boolean" ? b.grant_included : undefined, periodEnd: b.period_end, adminEmail: who(req) });
  await record(req, "plan.assign", { orgId: out.org_id, target: out.plan_id, detail: `Plan set to ${out.plan_name}${b.unmetered === true ? " (no minute limit)" : ""}` });
  res.json(out);
}

export async function setTerms(req, res) {
  const b = object(req.body, "the request");
  const out = await Billing.setTerms(req.params.orgId, b.terms, { adminEmail: who(req) });
  await record(req, "terms.change", { orgId: out.org_id, detail: `Terms changed: ${Object.entries(b.terms).map(([k, v]) => `${k}=${v}`).join(", ").slice(0, 300)}` });
  res.json(out);
}

export async function setStatus(req, res) {
  const out = await Billing.setStatus(req.params.orgId, req.body?.status, { adminEmail: who(req) });
  await record(req, "plan.status", { orgId: out.org_id, target: out.status, detail: `Plan status set to ${out.status}` });
  res.json(out);
}

export async function setUnmetered(req, res) {
  const out = await Billing.setUnmetered(req.params.orgId, req.body?.unmetered, { adminEmail: who(req) });
  await record(req, "plan.unmetered", { orgId: out.org_id, target: String(out.unmetered), detail: out.unmetered ? "No minute limit" : "Minutes counted" });
  res.json(out);
}

export async function renew(req, res) {
  const out = await Billing.renew(req.params.orgId, { adminEmail: who(req) });
  await record(req, "plan.renew", { orgId: out.org_id, detail: `Renewed to ${out.period_end}` });
  res.json(out);
}

export async function adjustMinutes(req, res) {
  await AdminOps.orgDetail(req.params.orgId); // a 404 for an organization that is not there, before anything is written
  const note = typeof req.body?.note === "string" ? req.body.note : "";
  const balance = await Billing.adjust(req.params.orgId, req.body?.minutes, { actor: "Kaho AI", note });
  await record(req, "minutes.adjust", { orgId: req.params.orgId, detail: `${req.body.minutes > 0 ? "+" : ""}${req.body.minutes} minutes${note ? `: ${note}` : ""}` });
  res.json({ ...(await Billing.get(req.params.orgId)), balance_minutes: balance });
}

export async function plans(_req, res) { res.json(await Billing.listPlans({ all: true })); }
export async function updatePlan(req, res) {
  const out = await Billing.updatePlan(req.params.planId, object(req.body, "the plan"), { adminEmail: who(req) });
  await record(req, "plan.edit", { target: out.id, detail: `Rate card changed: ${Object.keys(req.body).join(", ")}` });
  res.json(out);
}

export async function topups(req, res) { res.json(await AdminOps.listTopups({ status: req.query.status, page: req.query.page, perPage: req.query.per_page, org: req.query.org })); }
export const decide = (approve) => async (req, res) => {
  const note = typeof req.body?.note === "string" ? req.body.note : "";
  const out = await Billing.decideTopup(req.params.id, { approve, adminEmail: who(req), note });
  await record(req, approve ? "topup.approve" : "topup.reject", { target: out.id, detail: `${out.reference}: ${out.minutes} minutes` });
  res.json(out);
};

export async function requests(req, res) { res.json(await Requests.adminList({ status: req.query.status, page: req.query.page, perPage: req.query.per_page })); }
export async function notifications(req, res) { res.json(await AdminOps.notifications({ page: req.query.page, perPage: req.query.per_page })); }
export async function decideRequest(req, res) {
  const out = await Requests.decide(req.params.id, { action: req.body?.action, response: req.body?.response, adminEmail: who(req) });
  await record(req, `request.${out.status === "done" ? "done" : "dismiss"}`, { orgId: out.org_id, target: out.id, detail: out.response ?? "" });
  await Billing.tell(out.org_id, out.status === "done" ? "Kaho answered your request." : "Kaho closed your request.", { actor: "Kaho AI" });
  const shown = { ...out };
  delete shown.org_id; // the organization is told separately; the page does not need it
  res.json(shown);
}

export async function users(req, res) { res.json(await AdminOps.listUsers({ q: req.query.q, page: req.query.page, perPage: req.query.per_page })); }
export const disable = (disabled) => async (req, res) => {
  const out = await AdminOps.setUserDisabled(req.params.userId, disabled);
  await record(req, disabled ? "user.disable" : "user.enable", { target: out.id, detail: `${disabled ? "Switched off" : "Switched on"} ${out.email}` });
  res.json(out);
};
export async function resetPassword(req, res) {
  const out = await AdminOps.resetPassword(req.params.userId);
  await record(req, "user.reset_password", { target: out.id, detail: `Password reset for ${out.email}` }); // the password itself is never written down
  res.json(out);
}

export async function changeRole(req, res) {
  const out = await AdminOps.changeRole(req.params.orgId, req.params.userId, req.body?.role);
  await record(req, "member.role", { orgId: req.params.orgId, target: out.id, detail: `${out.name} is now ${out.role}` });
  await Billing.tell(req.params.orgId, `Kaho changed ${out.name}'s role to ${out.role}.`);
  res.json(out);
}
export async function removeMember(req, res) {
  const out = await AdminOps.removeMember(req.params.orgId, req.params.userId);
  await record(req, "member.remove", { orgId: req.params.orgId, target: out.id, detail: `Removed ${out.name}` });
  await Billing.tell(req.params.orgId, `Kaho removed ${out.name} from the organization.`);
  res.json(out);
}

export async function impersonate(req, res) {
  const out = await AdminOps.startSupport(req.params.orgId, req.body?.user_id, who(req));
  await record(req, "support.open", { orgId: req.params.orgId, target: req.body.user_id, detail: `Opened the Studio as ${out.person}` });
  res.json(out);
}

export async function audit(req, res) { res.json(await AdminOps.auditPage({ page: req.query.page, perPage: req.query.per_page })); }
export async function health(_req, res) { res.json(await platformHealth()); }
