import * as CustomTool from "../models/CustomTool.js";
import { note } from "./notify.js";

export async function list(req, res) {
  res.json(await CustomTool.list(req.user.org_id));
}

export async function create(req, res) {
  const tool = await CustomTool.create(req.user.org_id, req.body ?? {});
  await note(req, "agent", `Added the tool ${tool.label}`, "tool-calls");
  res.json(tool);
}

export async function update(req, res) {
  res.json(await CustomTool.update(req.user.org_id, req.params.toolId, req.body ?? {}));
}

export async function remove(req, res) {
  const gone = await CustomTool.remove(req.user.org_id, req.params.toolId);
  await note(req, "agent", `Removed the tool ${gone.label}`, "tool-calls");
  res.json({ ok: true });
}

/** Send the real request with sample values, and show the person what came back. */
export async function test(req, res) {
  res.json(await CustomTool.test(req.user.org_id, req.params.toolId, req.body ?? {}));
}
