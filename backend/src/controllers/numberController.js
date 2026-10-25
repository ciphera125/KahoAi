import * as PhoneNumber from "../models/PhoneNumber.js";
import * as Agent from "../models/Agent.js";
import { note } from "./notify.js";

async function withRoute(orgId, row) {
  return { ...row, agent_id: (await Agent.routes(orgId))[row.number] ?? null };
}

export async function list(req, res) {
  const org = req.user.org_id;
  const [rows, routes] = await Promise.all([PhoneNumber.listPublic(org), Agent.routes(org)]);
  res.json(rows.map((r) => ({ ...r, agent_id: routes[r.number] ?? null })));
}

export async function add(req, res) {
  const { provider, number, label, credentials } = req.body ?? {};
  const row = await PhoneNumber.add(req.user.org_id, { provider: String(provider ?? ""), number: String(number ?? ""), label, credentials });
  await note(req, "number", `Added the number ${row.number}`, "numbers", row.id);
  res.json(await withRoute(req.user.org_id, row));
}

export async function update(req, res) {
  const row = await PhoneNumber.update(req.user.org_id, req.params.numberId, { label: req.body?.label, credentials: req.body?.credentials });
  const changed = Object.values(req.body?.credentials ?? {}).some(Boolean) ? "credentials" : "name";
  await note(req, "number", `Changed the ${changed} of ${row.number}`, "numbers", row.id);
  res.json(await withRoute(req.user.org_id, row));
}

export async function route(req, res) {
  const org = req.user.org_id;
  const row = await PhoneNumber.getPublic(org, req.params.numberId);
  await Agent.routeNumber(org, row.number, req.body?.agent_id || null);
  const out = await withRoute(org, row);
  const name = out.agent_id ? (await Agent.names(org))[out.agent_id] : "the default persona";
  await note(req, "number", `${row.number} now answers with ${name}`, "numbers", row.id);
  res.json(out);
}

export async function makeDefault(req, res) {
  const row = await PhoneNumber.setDefault(req.user.org_id, req.params.numberId);
  await note(req, "number", `${row.number} is now the default number`, "numbers", row.id);
  res.json(await withRoute(req.user.org_id, row));
}

export async function remove(req, res) {
  const row = await PhoneNumber.remove(req.user.org_id, req.params.numberId);
  await note(req, "number", `Removed the number ${row.number}`, "numbers");
  res.json({ deleted: row.id });
}
