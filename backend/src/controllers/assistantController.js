import * as Assistant from "../models/Assistant.js";
import { can } from "../models/permissions.js";
import { HttpError } from "../utils/errors.js";

/** The assistant is for people who can build agents or tools; everyone else has nothing it could build. */
function requireBuilder(req) {
  if (!can(req.user.role, "agents.edit") && !can(req.user.role, "tools.custom")) {
    throw new HttpError(403, "your role does not allow setting things up; ask an admin of this organization");
  }
}

export async function message(req, res) {
  requireBuilder(req);
  res.json(await Assistant.converse({ orgId: req.user.org_id, role: req.user.role,
    agentId: req.body?.agent_id || null, messages: req.body?.messages }));
}

export async function undo(req, res) {
  requireBuilder(req);
  res.json(await Assistant.undo({ orgId: req.user.org_id, role: req.user.role,
    agentId: req.body?.agent_id, undo: req.body?.undo }));
}
