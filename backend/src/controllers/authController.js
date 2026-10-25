import * as User from "../models/User.js";
import * as Activity from "../models/Activity.js";
import { cookieOptions, DEVICE_COOKIE, SESSION_COOKIE } from "../middleware/auth.js";
import { note } from "./notify.js";

async function signedIn(req, res, user) {
  res.cookie(SESSION_COOKIE, await User.startSession(user.id, user.org_id), cookieOptions(User.SESSION_SECS));
  if (!(await User.knowsDevice(user.id, req.cookies?.[DEVICE_COOKIE]))) {
    res.cookie(DEVICE_COOKIE, await User.issueDevice(user.id), cookieOptions(User.DEVICE_SECS));
  }
  res.json(user);
}

export async function state(_req, res) {
  res.json({ has_accounts: await User.hasAccounts() });
}

export async function signUp(req, res) {
  const user = await User.signUp(req.body ?? {});
  await Activity.add(user.org_id, "account", user.role === "owner" ? `${user.name} created ${user.org_name}`
    : `${user.name} joined ${user.org_name}`, { view: "team", actor: user.name });
  await signedIn(req, res, user);
}

export async function signIn(req, res) {
  const { email, password } = req.body ?? {};
  await signedIn(req, res, await User.checkPassword(email, password, req.cookies?.[DEVICE_COOKIE], req.ip));
}

/** Every other session ends; this browser gets a fresh one. */
export async function changePassword(req, res) {
  await User.changePassword(req.user.id, req.body?.current, req.body?.new);
  await note(req, "account", `${req.user.name} changed their password`, "dashboard");
  await signedIn(req, res, req.user);
}

export async function newInvite(req, res) {
  const invite = await User.currentInvite(req.user.org_id, { renew: true });
  res.json({ invite_code: invite.code, invite_expires: invite.expires });
}

export async function signOut(req, res) {
  await User.endSession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ signed_out: true });
}

/** Signs out every other browser on this account. */
export async function signOutOthers(req, res) {
  await User.endOtherSessions(req.user.id, req.cookies?.[SESSION_COOKIE]);
  await note(req, "account", `${req.user.name} signed out their other browsers`, "team");
  res.json({ ok: true });
}

export async function team(req, res) {
  res.json(await User.members(req.user.org_id));
}

export async function changeRole(req, res) {
  const out = await User.changeRole(req.user, req.params.userId, req.body?.role);
  await note(req, "account", `${out.name} is now ${out.role === "admin" ? "an admin" : "a member"}`, "team");
  res.json(out);
}

export async function removeMember(req, res) {
  const removed = await User.removeMember(req.user, req.params.userId);
  await note(req, "account", `${req.user.name} removed ${removed.name} from the organization`, "team");
  res.json({ removed: removed.id });
}
