import * as BulkCall from "../models/BulkCall.js";
import { ValidationError } from "../utils/errors.js";
import { note } from "./notify.js";

export async function list(req, res) {
  res.json(await BulkCall.list(req.user.org_id));
}

export async function create(req, res) {
  const body = req.body ?? {};
  if (body.consent !== true) throw new ValidationError("confirm that everyone on this list has agreed to be called");
  const run = await BulkCall.create(req.user.org_id, { name: body.name, agentId: body.agent_id, fromId: body.from_id,
    parallel: body.parallel, rows: body.rows, createdBy: req.user.name });
  await note(req, "call", `Started the bulk call ${run.name}: ${run.counts.queued} to call with ${run.agent_name}`, "bulk", run.id);
  res.json(run);
}

export async function get(req, res) {
  res.json(await BulkCall.get(req.user.org_id, req.params.runId));
}

export const act = (action) => async (req, res) => {
  const run = await BulkCall.act(req.user.org_id, req.params.runId, action);
  await note(req, "call", `${{ pause: "Paused", resume: "Resumed", cancel: "Cancelled" }[action]} the bulk call ${run.name}`, "bulk", run.id);
  res.json(run);
};
