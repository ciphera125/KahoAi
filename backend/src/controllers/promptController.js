import * as Prompt from "../models/Prompt.js";
import { note } from "./notify.js";

/** Where a notification about this prompt should take you. */
const ref = (p) => (p.agent_id ? ["agents", `${p.agent_id}/${p.id}`] : ["prompts", p.id]);

export async function list(req, res) {
  res.json(await Prompt.list(req.user.org_id));
}

export async function create(req, res) {
  const { name, prompt: text, agent_id: agentId } = req.body ?? {};
  const prompt = await Prompt.create(req.user.org_id, { name, text, agentId: agentId || null });
  await note(req, "prompt", `Created the prompt ${prompt.name}`, ...ref(prompt));
  res.json(prompt);
}

export async function get(req, res) {
  res.json(await Prompt.get(req.user.org_id, req.params.promptId));
}

export async function update(req, res) {
  const before = await Prompt.get(req.user.org_id, req.params.promptId);
  const prompt = await Prompt.update(req.user.org_id, req.params.promptId, { name: req.body?.name, text: req.body?.text });
  if (prompt.version_count !== before.version_count || prompt.prompt !== before.prompt) {
    await note(req, "prompt", `Saved a new version of ${prompt.name}`, ...ref(prompt));
  } else if (prompt.name !== before.name) {
    await note(req, "prompt", `Renamed the prompt ${before.name} to ${prompt.name}`, ...ref(prompt));
  }
  res.json(prompt);
}

export async function assign(req, res) {
  const prompt = await Prompt.assign(req.user.org_id, req.params.promptId, req.body?.agent_id || null);
  await note(req, "prompt", `Moved the prompt ${prompt.name} to ${prompt.agent_name || "no agent"}`, ...ref(prompt));
  res.json(prompt);
}

export async function remove(req, res) {
  const prompt = await Prompt.remove(req.user.org_id, req.params.promptId);
  await note(req, "prompt", `Deleted the prompt ${prompt.name}`, "prompts");
  res.json({ deleted: req.params.promptId });
}

export async function versions(req, res) {
  res.json(await Prompt.versions(req.user.org_id, req.params.promptId));
}

export async function restoreVersion(req, res) {
  const prompt = await Prompt.restoreVersion(req.user.org_id, req.params.promptId, req.params.versionId);
  await note(req, "prompt", `Restored an earlier version of ${prompt.name}`, ...ref(prompt));
  res.json(prompt);
}

export async function deleteVersion(req, res) {
  await Prompt.deleteVersion(req.user.org_id, req.params.promptId, req.params.versionId);
  res.json({ deleted: req.params.versionId });
}
