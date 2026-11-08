import * as Assistant from "../models/Assistant.js";
import { can } from "../models/permissions.js";
import { HttpError } from "../utils/errors.js";
import { note } from "./notify.js";

/** The assistant is for people who can build agents or tools; everyone else has nothing it could save. */
function requireBuilder(req) {
  if (!can(req.user.role, "agents.edit") && !can(req.user.role, "tools.custom")) {
    throw new HttpError(403, "your role does not allow setting things up; ask an admin of this organization");
  }
}

export async function message(req, res) {
  requireBuilder(req);
  res.json(await Assistant.converse({ messages: req.body?.messages }));
}

export async function apply(req, res) {
  requireBuilder(req);
  const out = await Assistant.apply(req.user.org_id, req.body?.agent_id, req.body?.proposal, {
    canBuild: can(req.user.role, "agents.edit"), canTools: can(req.user.role, "tools.custom") });
  await note(req, "agent", `Set up ${out.agent.name} by chatting with the assistant`, "agents", out.agent.id);
  res.json(out);
}
