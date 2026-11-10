import * as CustomTool from "../models/CustomTool.js";
import * as ToolLog from "../models/ToolLog.js";
import { logger } from "../utils/logger.js";
import { note } from "./notify.js";

const logTool = (req, action, tool, detail) => ToolLog.record(req.user.org_id, { actor: req.user.name, role: req.user.role, action,
  source: "studio", kind: "look_up", toolName: tool.name, toolLabel: tool.label, detail })
  .catch((err) => logger.warn({ err: err.message }, "could not write the tool log"));

export async function list(req, res) {
  res.json(await CustomTool.list(req.user.org_id));
}

export async function create(req, res) {
  const tool = await CustomTool.create(req.user.org_id, req.body ?? {});
  await note(req, "agent", `Added the tool ${tool.label}`, "tool-calls");
  await logTool(req, "created", tool, `Added the tool ${tool.label}`);
  res.json(tool);
}

export async function update(req, res) {
  const tool = await CustomTool.update(req.user.org_id, req.params.toolId, req.body ?? {});
  await note(req, "agent", `Changed the tool ${tool.label}`, "tool-calls");
  await logTool(req, "updated", tool, `Changed the tool ${tool.label}`);
  res.json(tool);
}

export async function remove(req, res) {
  const gone = await CustomTool.remove(req.user.org_id, req.params.toolId);
  await note(req, "agent", `Removed the tool ${gone.label}`, "tool-calls");
  await logTool(req, "removed", gone, `Removed the tool ${gone.label}`);
  res.json({ ok: true });
}

/** Send the real request with sample values, and show the person what came back. */
export async function test(req, res) {
  res.json(await CustomTool.test(req.user.org_id, req.params.toolId, req.body ?? {}));
}
