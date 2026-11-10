import * as Assistant from "../models/Assistant.js";
import * as BuilderHistory from "../models/BuilderHistory.js";
import * as ToolLog from "../models/ToolLog.js";
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
    actor: req.user.name, agentId: req.body?.agent_id || null, messages: req.body?.messages, editedFrom: req.body?.edited_from }));
}

export async function undo(req, res) {
  requireBuilder(req);
  res.json(await Assistant.undo({ orgId: req.user.org_id, role: req.user.role,
    actor: req.user.name, agentId: req.body?.agent_id, undo: req.body?.undo }));
}

export async function history(req, res) {
  requireBuilder(req);
  res.json(await BuilderHistory.page(req.user.org_id, { page: req.query.page, perPage: req.query.per_page, q: req.query.q, agentId: req.query.agent_id }));
}

export async function toolLog(req, res) {
  res.json(await ToolLog.page(req.user.org_id, { page: req.query.page, perPage: req.query.per_page, q: req.query.q,
    source: req.query.source, agentId: req.query.agent_id }));
}

export async function archiveRun(req, res) {
  const { archiveOnce } = await import("../services/archive.js");
  const days = Math.min(3650, Math.max(1, Math.floor(Number(req.body?.days)) || 2));
  res.json(await archiveOnce({ days }));
}

export async function archiveStatus(req, res) {
  const { status, FOLDERS } = await import("../services/archive.js");
  const { recordingsConfigured } = await import("../services/storage.js");
  const s = status();
  res.json({ configured: recordingsConfigured(), last_run: s.lastRun, last_filed: s.lastFiled, last_error: s.lastError,
    folders: ["1-recordings", "2-transcripts", "3-users", "4-user-emails", "5-unique-users", ...FOLDERS] });
}

export async function health(req, res) {
  const { systemHealth } = await import("../services/health.js");
  res.json(await systemHealth(req.user.org_id));
}
