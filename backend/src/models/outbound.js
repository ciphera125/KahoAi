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

/** The 16 bytes of an IPv6 address, or null. Handles "::" and a dotted IPv4 tail. */
function v6Bytes(ip) {
  let text = ip;
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const q = tail[1].split(".").map(Number);
    if (q.some((n) => n > 255)) return null;
    text = text.slice(0, -tail[1].length) + `${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

/** Whether an address is one nobody outside should be able to reach through us. IPv6 forms that
 * carry an IPv4 address inside them (mapped, compatible, NAT64, 6to4) are judged by that address. */
export function isPrivateAddress(address) {
  const ip = String(address).toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) return PRIVATE_V4.some((p) => p.test(ip));
  if (isIP(ip) !== 6) return false;
  const b = v6Bytes(ip);
  if (!b) return true; // something we cannot read is not something we call
  const v4 = (o) => PRIVATE_V4.some((p) => p.test(`${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`));
  if (b.slice(0, 15).every((x) => x === 0)) return true;                      // :: and ::1
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return v4(12); // ::ffff:a.b.c.d
  if (b.slice(0, 12).every((x) => x === 0)) return v4(12);                    // ::a.b.c.d
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return v4(12); // 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2);                           // 6to4
  if ((b[0] & 0xfe) === 0xfc) return true;                                    // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) >= 0x80) return true;                    // fe80::/10 link-local, fec0::/10
  if (b[0] === 0xff) return true;                                             // multicast
  return false;
}

/** Names that only ever mean "this machine or this network". */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;

/** Whether an address is this very machine (127.x, ::1, or either hidden inside an IPv6 form). */
function isLoopbackAddress(bare) {
  if (isIP(bare) === 4) return /^127\./.test(bare);
  const b = isIP(bare) === 6 ? v6Bytes(bare) : null;
  if (!b) return false;
  if (b.slice(0, 15).every((x) => x === 0)) return b[15] === 1;
  const embedded = (o) => b[o] === 127;
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return embedded(12);
  return b.slice(0, 12).every((x) => x === 0) && embedded(12);
}

/** Why this URL may not be called, in plain words, or null. In production nothing on this machine
 * or its network may be called, loopback included; while developing, plain http to localhost is fine. */
export function urlProblem(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return "That is not a web address."; }
  if (!["https:", "http:"].includes(url.protocol)) return "The address has to start with https.";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  const loopback = config.NODE_ENV !== "production"
    && (host === "localhost" || host.endsWith(".localhost") || isLoopbackAddress(bare));
  if (loopback) return null;
  if (url.protocol === "http:") return "The address has to start with https.";
  if (LOCAL_NAME.test(host) || isPrivateAddress(bare)) return "That address is on a private network, so we cannot call it.";
  return null;
}

/** The address a hostname really points at, checked so a public name cannot be used to
 * reach a private address (the name is resolved once, then the request is made). */
async function resolvedProblem(hostname) {
  if (isIP(hostname.replace(/^\[|\]$/g, ""))) return null; // already checked by urlProblem
  if (config.NODE_ENV !== "production" && /(^|\.)localhost$/.test(hostname.toLowerCase())) return null;
  try {
    const found = await lookup(hostname, { all: true }); // every address it answers with, not just the first
    return found.some((f) => isPrivateAddress(f.address)) ? "That address resolves to a private network, so we cannot call it." : null;
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
