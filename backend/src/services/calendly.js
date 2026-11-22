// Calendly's API, for booking a meeting on a call (owner, 2026-11-22). Read from developer.calendly.com the
// same day: a personal access token as a bearer, available times in UTC (31 days at most), and POST /invitees
// to book directly, after which Calendly sends its own confirmation e-mails exactly as for a booking made on
// its page. We send no mail of our own.
//
// The token belongs to the customer's organization and is only ever sent to Calendly. Every reply is turned into
// a kind of problem (never Calendly's own words), so nothing a model reads out can carry a token or a header.
import { config } from "../config/env.js";
import { callOut } from "../models/outbound.js";
import { logger } from "../utils/logger.js";

/** A name someone typed into Calendly, made safe to hand to a model and to show on a page: one short line, no control
 * or direction-changing characters, no angle brackets. A meeting called "Ignore all previous instructions" stays
 * a few harmless words and cannot start a second line of its own. */
export function label(value, max = 80) {
  if (typeof value !== "string") return "";
  const kept = [...value.replace(/\s+/g, " ")].filter((ch) => {
    const c = ch.codePointAt(0);
    return c >= 32 && c !== 127 && !(c >= 0x200b && c <= 0x200f) && !(c >= 0x202a && c <= 0x202e) && !(c >= 0x2066 && c <= 0x2069) && ch !== "<" && ch !== ">";
  }).join("").trim();
  return [...kept].slice(0, max).join("");
}

/** One deadline for every request; a test shortens it. */
export const limits = { timeoutMs: 8000 };

// A personal access token is a long run of letters, digits, dots, dashes and underscores.
export const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{20,2000}$/;
const EVENT_TYPE_URI = /^https:\/\/api\.calendly\.com\/event_types\/([A-Za-z0-9_-]{8,64})$/;
export const isEventTypeUri = (value) => typeof value === "string" && EVENT_TYPE_URI.test(value);
const eventTypeId = (uri) => uri.match(EVENT_TYPE_URI)?.[1] ?? null;

// Production only ever talks to Calendly itself; the setting exists for tests.
const base = () => (config.NODE_ENV === "production" ? "https://api.calendly.com" : config.CALENDLY_API_BASE).replace(/\/+$/, "");

const kindOf = (out) => {
  if (out.status === 401) return "auth";
  if (out.status === 403) return "scope";
  if (out.status === 404) return "gone";
  if (out.status === 400) return "invalid";
  if (out.status === 429) return "limit";
  return out.status ? "down" : "unreachable";
};

async function call(token, method, path, { query = {}, body = null, attempts = 2 } = {}) {
  const url = new URL(base() + path);
  for (const [key, value] of Object.entries(query)) for (const one of [].concat(value)) url.searchParams.append(key, String(one));
  const out = await callOut({
    url: url.toString(), method, timeoutMs: limits.timeoutMs, attempts,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body === null ? null : JSON.stringify(body),
  });
  if (out.ok) return { ok: true, data: out.body };
  const kind = kindOf(out);
  // The status and path only: never the reply text, which could echo what was sent.
  logger.warn({ kind, status: out.status ?? null, path }, "calendly did not accept a request");
  return { ok: false, kind, status: out.status ?? null, detail: String(out.body?.message ?? "").slice(0, 200) };
}

/** Whose token this is. */
export async function me(token) {
  const r = await call(token, "GET", "/users/me");
  if (!r.ok) return r;
  const u = r.data?.resource;
  if (!u?.uri) return { ok: false, kind: "down" };
  return { ok: true, user: { uri: String(u.uri), name: label(u.name, 120), email: label(u.email, 200), timezone: label(u.timezone, 60) } };
}

/** The meeting types this person offers, and whether an agent can book each one. */
export async function eventTypes(token, userUri) {
  const r = await call(token, "GET", "/event_types", { query: { user: userUri, active: "true", count: 50 } });
  if (!r.ok) return r;
  const items = (r.data?.collection ?? []).filter((e) => isEventTypeUri(e?.uri)).map((e) => {
    const paid = e.is_paid === true;
    return { uri: e.uri, name: label(e.name), duration: Number(e.duration) || null, bookable: !paid,
      reason: paid ? "This meeting takes payment, which Calendly does not let an agent book." : null };
  });
  return { ok: true, items };
}

/** One meeting type, as far as booking needs to know it. */
export async function eventType(token, uri) {
  const id = eventTypeId(uri ?? "");
  if (!id) return { ok: false, kind: "invalid" };
  const r = await call(token, "GET", `/event_types/${id}`);
  if (!r.ok) return r;
  const e = r.data?.resource;
  if (!e?.uri) return { ok: false, kind: "gone" };
  return { ok: true, type: { uri: e.uri, name: label(e.name), duration: Number(e.duration) || null, paid: e.is_paid === true,
    active: e.active !== false, roundRobin: e.pooling_type === "round_robin", locations: Array.isArray(e.locations) ? e.locations : [] } };
}

/** The open times of a meeting type between two instants (31 days at most), as milliseconds. */
export async function availableTimes(token, uri, fromMs, toMs) {
  const r = await call(token, "GET", "/event_type_available_times",
    { query: { event_type: uri, start_time: new Date(fromMs).toISOString(), end_time: new Date(toMs).toISOString() } });
  if (!r.ok) return r;
  const times = (r.data?.collection ?? []).filter((s) => s?.status === "available").map((s) => Date.parse(s.start_time)).filter(Number.isFinite);
  return { ok: true, times: times.sort((a, b) => a - b) };
}

/** Book the time. Never repeated: after a timeout nobody knows whether Calendly acted, and a second request
 * could book a second meeting. */
export async function invite(token, { eventTypeUri, startMs, name, email, timezone, location }) {
  const body = { event_type: eventTypeUri, start_time: new Date(startMs).toISOString(), invitee: { name, email, timezone } };
  if (location) body.location = location;
  const r = await call(token, "POST", "/invitees", { body, attempts: 1 });
  if (!r.ok) return r;
  return { ok: true, eventUri: String(r.data?.resource?.event ?? "").slice(0, 300) || null };
}

/** After a booking that timed out: was the meeting made? */
export async function findBooking(token, { userUri, email, startMs }) {
  const r = await call(token, "GET", "/scheduled_events", { query: {
    user: userUri, invitee_email: email, status: "active", count: 5,
    min_start_time: new Date(startMs - 60000).toISOString(), max_start_time: new Date(startMs + 60000).toISOString() } });
  if (!r.ok) return r;
  const found = (r.data?.collection ?? []).find((e) => Math.abs(Date.parse(e.start_time) - startMs) < 60000);
  return { ok: true, found: Boolean(found), eventUri: found ? String(found.uri ?? "").slice(0, 300) : null };
}
