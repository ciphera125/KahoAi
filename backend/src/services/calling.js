// Placing one call: every rule a call must pass, in one place, for a call from
// the Calls page and for each row of a bulk call alike.
import { config } from "../config/env.js";
import * as Agent from "../models/Agent.js";
import * as Call from "../models/Call.js";
import * as Contact from "../models/Contact.js";
import * as PhoneNumber from "../models/PhoneNumber.js";
import * as dialer from "./dialer.js";
import { HttpError, ValidationError } from "../utils/errors.js";
import { CALL_ID, normalizeNumber } from "../utils/phone.js";

/** The agent's calling window is closed right now. */
export class OutsideWindowError extends HttpError {
  constructor(window) {
    super(400, Agent.OUTSIDE_WINDOW);
    this.code = "outside_call_window";
    this.window = { start: window.start, end: window.end, timezone: window.timezone };
  }
}

/** Dial `to` once from one of the organization's numbers, through an agent if
 * given. Throws (ValidationError, OutsideWindowError, or the dialler's 502)
 * when the call is not placed; a dial is never retried. */
export async function placeCall(org, { fromId, to: raw, agentId, now = new Date() }) {
  const rows = await PhoneNumber.listPublic(org);
  const row = fromId ? rows.find((r) => r.id === fromId) : rows.find((r) => r.is_default);
  if (!row) throw new ValidationError("choose a number to call from");
  if (row.status === "not_connected") {
    throw new ValidationError(`${row.provider_label} numbers are not connected yet; only Plivo can place calls today`);
  }
  if (row.status !== "active") throw new ValidationError(`${row.number} is missing credentials; edit it on Numbers`);
  const to = dialer.checkNumber(normalizeNumber(String(raw ?? "")), "The number");
  // TRAI: a person who asked not to be called is never dialled, until someone clears it on purpose.
  if (await Contact.isDnc(org, to)) throw new ValidationError(`${to} is marked Do not call in Contacts`);
  let agent = null;
  if (agentId) {
    agent = await Agent.callConfig(agentId);
    if (!agent || agent.org_id !== org) throw new ValidationError("choose an agent that exists");
    if (!Agent.inCallWindow(agent.call_window, now)) throw new OutsideWindowError(agent.call_window);
  }
  const missing = ["PUBLIC_HOST", "WEBHOOK_SECRET"].filter((k) => !config[k]);
  if (missing.length) throw new ValidationError(`missing in the server settings: ${missing.join(", ")}`);
  const creds = await PhoneNumber.credentials(org, row.id);
  const maxSecs = dialer.resolveMaxDuration(agent ? agent.max_secs : null);
  const answer = dialer.answerUrl({ to, maxSecs, studioAgent: agent?.agent_id });
  await dialer.preflight(answer, creds.auth_token);
  const result = await dialer.dial({ authId: creds.auth_id, authToken: creds.auth_token, from: row.number, to, answer,
    hangup: dialer.hangupUrl({ to, studioAgent: agent?.agent_id }), maxSecs,
    ringSecs: agent ? agent.ring_secs : dialer.DEFAULT_RING_TIMEOUT_SECS });
  const requestUuid = typeof result.request_uuid === "string" && CALL_ID.test(result.request_uuid) ? result.request_uuid : null;
  if (requestUuid) {
    await Call.recordOutcome(requestUuid, { status: "ringing", peer: to, ours: row.number, direction: "outbound",
      agent_id: agent?.agent_id, at: new Date().toISOString(), request_uuid: requestUuid }, { orgId: org });
  }
  return { to, from: row.number, request_uuid: requestUuid, agent, maxSecs };
}
