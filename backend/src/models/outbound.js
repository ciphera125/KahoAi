// Making a request to somebody else's API, safely.
//
// The URL is typed by a customer, so it is treated as hostile: https only (plain http
// for localhost in development), no redirects followed, no private or link-local
// address, a hard deadline, and a reply read only up to a limit. Without the address
// check a tool could be pointed at the cloud metadata service or at another service on
// our own network, and the agent would read the answer out loud.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config/env.js";

export const MAX_TIMEOUT_MS = 15000;
export const MAX_BODY_BYTES = 64 * 1024;

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^198\.1[89]\./, /^22[4-9]\./, /^2[3-5]\d\./,
];

/** Whether an address is one nobody outside should be able to reach through us. */
export function isPrivateAddress(address) {
  const ip = String(address).toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) return PRIVATE_V4.some((p) => p.test(ip));
  if (isIP(ip) === 6) {
    if (ip === "::" || ip === "::1") return true;
    if (/^(fc|fd|fe8|fe9|fea|feb)/.test(ip)) return true;      // unique-local, link-local
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // IPv4 wearing a hat
    if (mapped) return PRIVATE_V4.some((p) => p.test(mapped[1]));
    return false;
  }
  return false;
}

/** Why this URL may not be called, in plain words, or null. */
export function urlProblem(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return "That is not a web address."; }
  if (!["https:", "http:"].includes(url.protocol)) return "The address has to start with https.";
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol === "http:" && !(loopback && config.NODE_ENV !== "production")) {
    return "The address has to start with https.";
  }
  if (!loopback && isPrivateAddress(host)) return "That address is on a private network, so we cannot call it.";
  return null;
}

/** The address a hostname really points at, checked so a public name cannot be used to
 * reach a private address (the name is resolved once, then the request is made). */
async function resolvedProblem(hostname) {
  if (isIP(hostname)) return null; // already checked by urlProblem
  if (["localhost"].includes(hostname.toLowerCase())) return null;
  try {
    const { address } = await lookup(hostname);
    return isPrivateAddress(address) ? "That address resolves to a private network, so we cannot call it." : null;
  } catch {
    return "We could not find that address.";
  }
}

/**
 * One request to someone else's API. Never throws: it answers {ok, status, body, problem}.
 * Retries once, and only when nothing came back at all (a timeout or a refused
 * connection), because a request that was received may have already done something.
 */
export async function callOut({ url, method = "POST", headers = {}, body = null, timeoutMs = 6000 }) {
  const problem = urlProblem(url) ?? (await resolvedProblem(new URL(url).hostname));
  if (problem) return { ok: false, problem };

  const deadline = Math.min(Math.max(Number(timeoutMs) || 6000, 500), MAX_TIMEOUT_MS);
  let lastProblem = "We could not reach it.";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method, headers, body: body ?? undefined, redirect: "manual",
        signal: AbortSignal.timeout(deadline),
      });
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, status: response.status, problem: "It redirected us somewhere else, so we stopped." };
      }
      const text = (await response.text()).slice(0, MAX_BODY_BYTES);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      return { ok: response.ok, status: response.status, body: parsed, text,
        problem: response.ok ? null : `It answered ${response.status}.` };
    } catch (err) {
      // Nothing was received, so trying again cannot repeat anything that happened.
      lastProblem = err?.name === "TimeoutError" ? "It took too long to answer." : "We could not reach it.";
    }
  }
  return { ok: false, problem: lastProblem };
}

/** A very small subset of JSONPath: $.a.b, $.a[0].b, a.b. Enough to pull one value out
 * of a reply, and nothing that can run or loop. */
export function pick(body, path) {
  if (body === null || body === undefined) return undefined;
  const steps = String(path).replace(/^\$\.?/, "").split(".").filter(Boolean);
  let here = body;
  for (const step of steps) {
    const match = step.match(/^([^[\]]*)((\[\d+\])*)$/);
    if (!match) return undefined;
    if (match[1]) {
      if (here === null || typeof here !== "object") return undefined;
      here = here[match[1]];
    }
    for (const index of match[2].match(/\d+/g) ?? []) {
      if (!Array.isArray(here)) return undefined;
      here = here[Number(index)];
    }
    if (here === undefined) return undefined;
  }
  return here;
}
