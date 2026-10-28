// What the voice service asks of the Studio's data, and what it reports back.
import * as Agent from "../models/Agent.js";
import * as Call from "../models/Call.js";
import * as Contact from "../models/Contact.js";
import * as ErrorLog from "../models/ErrorLog.js";
import * as PhoneNumber from "../models/PhoneNumber.js";

/** Never an error: a call must start even if this lookup fails. */
export async function callConfig(req, res) {
  let agentId = typeof req.query.agent_id === "string" ? req.query.agent_id : null;
  if (!agentId && typeof req.query.number === "string") agentId = await Agent.agentForNumber(req.query.number);
  res.json({ config: agentId ? await Agent.callConfig(agentId) : null });
}

export async function recordOutcome(req, res) {
  await Call.recordOutcome(req.params.callId, req.body ?? {});
  res.json({ ok: true });
}

/** Whether a number is marked Do not call. A number that cannot be read is refused
 * by the caller: not being able to check is not permission. */
export async function dnc(req, res) {
  const number = String(req.query.number ?? "");
  const org = req.query.from ? await PhoneNumber.orgForNumber(String(req.query.from)) : null;
  // Our number unknown: refuse if any organization has this person on Do not call.
  res.json({ dnc: org ? await Contact.isDnc(org, number) : await Contact.isDncAnywhere(number) });
}

export async function ingest(req, res) {
  await Call.ingest(req.params.callId, req.body?.events);
  res.json({ ok: true });
}

export async function reportError(req, res) {
  const { level, source, message, call_id, org_id } = req.body ?? {};
  await ErrorLog.add(org_id || null, { level, source, message, call_id });
  res.json({ ok: true });
}
