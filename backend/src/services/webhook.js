// Tell the organization's own system a call has finished: what happened, the summary, and every
// answer the agent saved. Signed with the organization's secret so the receiver can trust it.
// It runs after the call, off the call path: a slow or broken receiver never touches a call.
import { createHmac } from "node:crypto";
import { asSystem } from "../db/pool.js";
import * as Activity from "../models/Activity.js";
import * as OrgSettings from "../models/OrgSettings.js";
import { callOut } from "../models/outbound.js";
import { reviewCall } from "./callReview.js";
import { logger } from "../utils/logger.js";

const sign = (secret, stamp, body) => `sha256=${createHmac("sha256", secret).update(`${stamp}.${body}`).digest("hex")}`;

/** Send the finished call once. Never throws: the worst case is a notification that it failed. */
export async function deliverCallCompleted(callId) {
  try {
    await reviewCall(callId); // judged first so the message can carry it; bounded and never raises
    const claimed = await asSystem((db) => db.query(
      `UPDATE calls SET webhook_sent_at = now() WHERE call_id = $1 AND webhook_sent_at IS NULL AND org_id IS NOT NULL
         AND summary IS NOT NULL RETURNING org_id, agent_id, direction, peer, started_at, ended_at, duration_secs, summary, lead, sentiment`, [callId]));
    const call = claimed.rows[0];
    if (!call) return;
    const hook = await OrgSettings.webhookOf(call.org_id);
    if (!hook) { // nothing to send to; leave it unclaimed so setting one later does not resend old calls
      await asSystem((db) => db.query("UPDATE calls SET webhook_sent_at = NULL WHERE call_id = $1", [callId]));
      return;
    }
    const { rows: answers } = await asSystem((db) => db.query(
      "SELECT field_key AS key, label, kind, value FROM call_answers WHERE call_id = $1 AND org_id = $2 ORDER BY at, id", [callId, call.org_id]));
    const body = JSON.stringify({ event: "call.completed", call_id: callId, agent_id: call.agent_id, direction: call.direction,
      peer: call.peer, started_at: call.started_at, ended_at: call.ended_at, duration_secs: call.duration_secs,
      summary: call.summary, lead: Boolean(call.lead), sentiment: call.sentiment ?? null, answers });
    const stamp = String(Math.floor(Date.now() / 1000));
    const out = await callOut({ url: hook.url, method: "POST", timeoutMs: 8000, body, headers: {
      "Content-Type": "application/json", "X-Kaho-Timestamp": stamp, "X-Kaho-Signature": sign(hook.secret, stamp, body) } });
    if (!out.ok) {
      logger.warn({ call: callId, status: out.status ?? null }, "call webhook failed");
      await Activity.add(call.org_id, "account", `Your call webhook did not accept a finished call (${out.problem ?? "no answer"})`,
        { view: "settings", actor: "Kaho AI" });
    }
  } catch (error) {
    logger.warn({ err: String(error?.message ?? error).slice(0, 200) }, "call webhook could not be sent");
  }
}
