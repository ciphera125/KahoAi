// Placing a call through Plivo, the way scripts/call.py does it:
// - nothing is dialled without the person's consent (checked by the controller);
// - the voice server is asked first, as Plivo will ask it, so an answered call
//   is never left with no one there;
// - placing a call is never retried: after a timeout the outcome is unknown and
//   a retry could ring the same person twice;
// - every network call has a deadline.
import { randomBytes } from "node:crypto";
import { config } from "../config/env.js";
import { HttpError, ValidationError } from "../utils/errors.js";
import { sign } from "./plivoSignature.js";

export const DEFAULT_MAX_SECS = 600;
export const FLOOR_SECS = 10;
export const DEFAULT_RING_TIMEOUT_SECS = 45;
// Plivo's own limit is only a backstop, so ours fires first and leaves a log.
const PLIVO_LIMIT_GRACE_SECS = 15;
const E164 = /^\+[1-9]\d{7,14}$/;

const failed = (message) => new HttpError(502, message);

export function checkNumber(raw, label) {
  const number = String(raw ?? "").replace(/[ \-()]/g, "");
  if (!E164.test(number)) {
    throw new ValidationError(`${label} '${String(raw ?? "").slice(0, 40)}' is not an international number. `
      + "Use E.164, for example +919876543210 (a + and the country code, no spaces).");
  }
  return number;
}

/** The requested length, else MAX_CALL_DURATION_SECS, else the default; never
 * above the server's ceiling and never below the floor. */
export function resolveMaxDuration(requested) {
  const raw = (config.MAX_CALL_DURATION_SECS || "").trim();
  const ceiling = raw ? Number(raw) : DEFAULT_MAX_SECS;
  if (!Number.isFinite(ceiling)) throw new HttpError(400, `MAX_CALL_DURATION_SECS='${raw}' is not a number.`);
  const value = requested === null || requested === undefined ? ceiling : Number(requested);
  if (value < FLOOR_SECS) throw new ValidationError(`the longest call must be at least ${FLOOR_SECS} seconds`);
  return Math.min(value, ceiling);
}

const base = () => `${config.PUBLIC_SCHEME}://${config.PUBLIC_HOST}`;

// The URL still carries the shared secret the live voice server checks first,
// AND the preflight signs the request the way Plivo does. Moving the secret out
// of the URL entirely is a planned, separately tested voice-server change (see
// HANDOFF): until server.py accepts the signature alone, dropping it here would
// make every call 403 against the running server.
export function answerUrl({ agent = "default", to, maxSecs, studioAgent }) {
  return `${base()}/answer?token=${encodeURIComponent(config.WEBHOOK_SECRET || "")}&agent=${encodeURIComponent(agent)}`
    + `&peer=${encodeURIComponent(to)}&max=${Number(maxSecs)}`
    + (studioAgent ? `&studio_agent=${encodeURIComponent(studioAgent)}` : "");
}

export function hangupUrl({ to, studioAgent }) {
  return `${base()}/hangup?token=${encodeURIComponent(config.WEBHOOK_SECRET || "")}&peer=${encodeURIComponent(to)}`
    + (studioAgent ? `&studio_agent=${encodeURIComponent(studioAgent)}` : "");
}

/** Fetch the answer URL as Plivo will, signed the way Plivo signs. */
export async function preflight(url, authToken) {
  const nonce = randomBytes(8).toString("hex");
  let res, text;
  try {
    res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(config.PREFLIGHT_TIMEOUT_MS),
      headers: { "X-Plivo-Signature-V3": sign("GET", url, {}, nonce, authToken), "X-Plivo-Signature-V3-Nonce": nonce } });
    text = await res.text();
  } catch (err) {
    throw failed(`Cannot reach ${base()} (${err.name}). Start the voice server and your tunnel, and check `
      + "PUBLIC_HOST. Nothing was dialled.");
  }
  if (res.status === 403) {
    throw failed("The voice server rejected the token: WEBHOOK_SECRET here does not match the one it was "
      + "started with. Restart it after editing .env. Nothing was dialled.");
  }
  if (res.status === 400) throw failed(`The voice server refused the call: ${text.trim().slice(0, 200)}`);
  if (res.status !== 200 || !text.includes("<Stream")) {
    throw failed(`The voice server answered ${res.status} and not the expected stream XML. Nothing was dialled.`);
  }
}

/** Ask Plivo to place the call. Never retried. */
export async function dial({ authId, authToken, from, to, answer, hangup, maxSecs, ringSecs }) {
  const unknown = "The call MAY OR MAY NOT have been placed. Check the Plivo console (Logs, Calls) before "
    + "trying again, or you may ring the same person twice.";
  const payload = { from, to, answer_url: answer, answer_method: "POST",
    time_limit: Math.floor(maxSecs) + PLIVO_LIMIT_GRACE_SECS, ring_timeout: ringSecs };
  if (hangup) Object.assign(payload, { hangup_url: hangup, hangup_method: "POST" });
  let res;
  try {
    res = await fetch(`${config.PLIVO_API_BASE}/v1/Account/${encodeURIComponent(authId)}/Call/`, {
      method: "POST", body: JSON.stringify(payload), signal: AbortSignal.timeout(config.PLIVO_DIAL_TIMEOUT_MS),
      headers: { "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${authId}:${authToken}`).toString("base64")}` } });
  } catch (err) {
    const code = err.cause?.code;
    if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"].includes(code) && err.name !== "TimeoutError") {
      throw failed(`Could not connect to Plivo (${code}). Nothing was dialled.`);
    }
    throw failed(`${err.name} talking to Plivo. ${unknown}`);
  }
  const text = await res.text().catch(() => "");
  if ([200, 201, 202].includes(res.status)) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  const detail = text.trim().slice(0, 200);
  if (res.status === 401 || res.status === 403) throw failed("Plivo rejected the Auth ID / Auth token. Nothing was dialled.");
  if (res.status === 400) throw failed(`Plivo refused the request: ${detail}. Nothing was dialled.`);
  if (res.status === 429) throw failed("Plivo is rate limiting this account. Nothing was dialled; wait and retry.");
  throw failed(`Plivo answered HTTP ${res.status}: ${detail}. ${unknown}`);
}
