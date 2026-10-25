// One person, several organizations: list them, make a new one, switch, join by invite.
import * as Activity from "../models/Activity.js";
import * as User from "../models/User.js";
import { SESSION_COOKIE } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";

export async function list(req, res) {
  res.json(await User.organizations(req.user.id, req.user.org_id));
}

/** A new organization, owned by whoever makes it, and this browser switched into it. */
export async function create(req, res) {
  const org = await User.createOrganization(req.user.id, req.body?.name);
  await User.switchOrganization(req.user.id, req.cookies?.[SESSION_COOKIE], org.id);
  await Activity.add(org.id, "account", `${req.user.name} created ${org.name}`, { view: "team", actor: req.user.name })
    .catch((err) => logger.warn({ err: err.message }, "could not record a notification"));
  res.json(org);
}

export async function switchTo(req, res) {
  res.json(await User.switchOrganization(req.user.id, req.cookies?.[SESSION_COOKIE], req.params.orgId));
}

export async function join(req, res) {
  const orgId = await User.joinOrganization(req.user.id, req.body?.invite);
  const org = await User.switchOrganization(req.user.id, req.cookies?.[SESSION_COOKIE], orgId);
  await Activity.add(orgId, "account", `${req.user.name} joined ${org.name}`, { view: "team", actor: req.user.name })
    .catch((err) => logger.warn({ err: err.message }, "could not record a notification"));
  res.json(org);
}
