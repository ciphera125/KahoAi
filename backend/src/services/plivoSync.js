// How recent calls ended, read from Plivo's call records (read-only at Plivo).
import { config } from "../config/env.js";
import { HttpError } from "../utils/errors.js";
import { normalizeNumber, CALL_ID } from "../utils/phone.js";

const PAGE = 20;
const MAX_PAGES = 25; // 500 calls: Plivo keeps only recent records in its list anyway

/** Plivo's CallStatus (or a record's call_state) and hangup cause, as one of
 * answered, declined, no_answer or failed. */
export function classify(status, cause, billedSecs = 0) {
  const s = String(status ?? "").trim().toLowerCase().replaceAll("_", "-");
  const c = String(cause ?? "").trim().toLowerCase();
  const billed = Number(billedSecs) || 0;
  if (c.includes("reject") || c.includes("declin") || c.includes("busy") || s === "busy") return "declined";
  if (billed > 0 || ["answer", "answered", "in-progress"].includes(s)) return "answered";
  if (s === "completed") return !c || c.includes("normal") ? "answered" : "failed";
  if (["no-answer", "no answer", "timeout", "cancel", "canceled", "cancelled"].includes(s)
    || c.includes("no answer") || c.includes("timeout") || c.includes("not answered")) return "no_answer";
  return "failed";
}

const tryNumber = (raw) => { try { return normalizeNumber(String(raw ?? "")); } catch { return null; } };

export function fromCdr(cdr, ours) {
  const numbers = [tryNumber(cdr.from_number), tryNumber(cdr.to_number)];
  const direction = String(cdr.call_direction).toLowerCase() === "inbound" ? "inbound" : "outbound";
  let peer = direction === "inbound" ? numbers[0] : numbers[1];
  if (peer === ours) peer = numbers.find((n) => n && n !== ours) ?? null;
  const at = cdr.initiation_time ? new Date(String(cdr.initiation_time).replace(" ", "T")) : null;
  return { status: classify(cdr.call_state, cdr.hangup_cause_name, cdr.bill_duration), cause: cdr.hangup_cause_name,
    peer, ours, direction, at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
    duration_secs: cdr.bill_duration, cost: cdr.total_amount };
}

/** Each page is one request with its own deadline. Calls onRecord(callId, fields). */
export async function syncFromPlivo({ authId, authToken, ours, onRecord }) {
  let recorded = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res;
    try {
      res = await fetch(`${config.PLIVO_API_BASE}/v1/Account/${encodeURIComponent(authId)}/Call/?limit=${PAGE}&offset=${page * PAGE}`, {
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Basic ${Buffer.from(`${authId}:${authToken}`).toString("base64")}` } });
    } catch (err) {
      throw new HttpError(502, `Could not reach Plivo (${err.name})`);
    }
    if (res.status !== 200) throw new HttpError(502, `Plivo answered HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    for (const cdr of body.objects ?? []) {
      const callId = String(cdr.call_uuid ?? "");
      if (CALL_ID.test(callId)) {
        await onRecord(callId, fromCdr(cdr, ours));
        recorded++;
      }
    }
    if (!body.meta?.next) break;
  }
  return recorded;
}
