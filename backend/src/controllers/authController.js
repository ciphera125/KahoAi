import { ROLES } from "../models/permissions.js";
import * as User from "../models/User.js";
import * as Invite from "../models/Invite.js";
import * as Activity from "../models/Activity.js";
import { cookieOptions, DEVICE_COOKIE, SESSION_COOKIE } from "../middleware/auth.js";
import { note } from "./notify.js";
import * as Audit from "../models/Audit.js";
import { forbidden } from "../utils/errors.js";

async function signedIn(req, res, user) {
  res.cookie(SESSION_COOKIE, await User.startSession(user.id, user.org_id), cookieOptions(User.SESSION_SECS));
  if (!(await User.knowsDevice(user.id, req.cookies?.[DEVICE_COOKIE]))) {
    res.cookie(DEVICE_COOKIE, await User.issueDevice(user.id), cookieOptions(User.DEVICE_SECS));
  }
  res.json(user);
}

/** Kaho support, from the admin site: a one-use link becomes a short session, and the person's team is told. */
export async function supportSignIn(req, res) {
  const { user, adminEmail } = await User.consumeSupportToken(req.body?.token);
  res.cookie(SESSION_COOKIE, await User.startSession(user.id, user.org_id, { impersonatedBy: adminEmail, secs: User.SUPPORT_SECS }),
    cookieOptions(User.SUPPORT_SECS));
  const text = `Kaho support signed in as ${user.name}.`;
  await Activity.add(user.org_id, "account", text, { view: "team", actor: "Kaho AI" }).catch(() => {});
  await Audit.record(user.org_id, { actor: "Kaho AI support", role: "staff", action: "support", detail: text }).catch(() => {});
  res.json(user);
}

export async function state(_req, res) {
  res.json({ has_accounts: await User.hasAccounts() });
}

export async function signUp(req, res) {
  const user = await User.signUp(req.body ?? {});
  await Activity.add(user.org_id, "account", user.role === "admin" ? `${user.name} created ${user.org_name}`
    : `${user.name} joined ${user.org_name} as ${roleLabel(user.role)}`, { view: "team", actor: user.name });
  await signedIn(req, res, user);
}

export async function signIn(req, res) {
  const { email, password } = req.body ?? {};
  await signedIn(req, res, await User.checkPassword(email, password, req.cookies?.[DEVICE_COOKIE], req.ip));
}

/** Every other session ends; this browser gets a fresh one. */
export async function changePassword(req, res) {
  if (req.user.support) throw forbidden("a password cannot be changed while Kaho support is signed in as you");
  await User.changePassword(req.user.id, req.body?.current, req.body?.new);
  await note(req, "account", `${req.user.name} changed their password`, "dashboard");
  await signedIn(req, res, req.user);
}

export async function signOut(req, res) {
  await User.endSession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ signed_out: true });
}

/** Signs out every other browser on this account. */
export async function signOutOthers(req, res) {
  if (req.user.support) throw forbidden("other browsers cannot be signed out while Kaho support is signed in as you");
  await User.endOtherSessions(req.user.id, req.cookies?.[SESSION_COOKIE]);
  await note(req, "account", `${req.user.name} signed out their other browsers`, "team");
  res.json({ ok: true });
}

export async function team(req, res) {
  res.json(await User.members(req.user.org_id));
}

/** "an admin", "a viewer", "an agent builder": the role's real name, with the right article. */
const roleLabel = (id) => (ROLES.find((r) => r.id === id)?.label ?? id).toLowerCase();
const aRole = (id) => `${/^[aeiou]/.test(roleLabel(id)) ? "an" : "a"} ${roleLabel(id)}`;

/** The open invite codes, each with the role it gives. */
export async function invites(req, res) {
  res.json(await Invite.list(req.user.org_id));
}

/** A new code for the role asked for. The text recorded for the team never holds the code itself. */
export async function makeInvite(req, res) {
  const made = await Invite.create(req.user.org_id, req.body?.role, req.user.name);
  await note(req, "account", `${req.user.name} made an invite code for ${aRole(made.role)}`, "team");
  res.json(made);
}

export async function cancelInvite(req, res) {
  const gone = await Invite.revoke(req.user.org_id, req.params.code);
  await note(req, "account", `${req.user.name} cancelled an invite code for ${aRole(gone.role)}`, "team");
  res.json({ cancelled: true });
}

export async function changeRole(req, res) {
  const out = await User.changeRole(req.user, req.params.userId, req.body?.role);
  await note(req, "account", `${out.name} is now ${aRole(out.role)}`, "team");
  res.json(out);
}

export async function removeMember(req, res) {
  const removed = await User.removeMember(req.user, req.params.userId);
  await note(req, "account", `${req.user.name} removed ${removed.name} from the organization`, "team");
  res.json({ removed: removed.id });
}
