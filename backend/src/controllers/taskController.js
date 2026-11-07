import * as Task from "../models/Task.js";
import * as ApiKey from "../models/ApiKey.js";
import { note } from "./notify.js";

export async function list(req, res) {
  res.json(await Task.list(req.user.org_id, { range: req.query.range ?? "all",
    status: req.query.status ?? "all", contactId: req.query.contact_id ?? null }));
}

export async function create(req, res) {
  const task = await Task.create(req.user.org_id, req.body ?? {}, { source: "studio" });
  res.json(task);
}

export async function update(req, res) {
  res.json(await Task.update(req.user.org_id, req.params.taskId, req.body ?? {}));
}

export async function remove(req, res) {
  const gone = await Task.remove(req.user.org_id, req.params.taskId);
  res.json({ ok: true, title: gone.title });
}

// --- the keys another system uses --------------------------------------------

export async function listKeys(req, res) {
  res.json(await ApiKey.list(req.user.org_id));
}

export async function createKey(req, res) {
  const key = await ApiKey.create(req.user.org_id, req.body ?? {}, req.user.id);
  await note(req, "account", `Made an API key, ${key.name || key.prefix}`, "settings");
  res.json(key);
}

export async function revokeKey(req, res) {
  const gone = await ApiKey.revoke(req.user.org_id, req.params.keyId);
  await note(req, "account", `Revoked the API key ${gone.name || ""}`.trim(), "settings");
  res.json({ ok: true });
}
