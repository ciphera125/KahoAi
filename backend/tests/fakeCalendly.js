// A stand-in for Calendly's API on a fixed local port (18768), so no test ever books a real meeting or sends a
// real e-mail. It answers the way Calendly's documentation says it does (developer.calendly.com, read
// 2026-11-22): bearer token, available times in UTC, a booking that needs an open slot, a list of events.
import http from "node:http";

const DAY = 86400000;
const IST = 19800000; // five and a half hours
const SLOTS = [[10, 0], [10, 30], [11, 0], [11, 30], [12, 0], [12, 30], [15, 0], [15, 30]]; // India time, every day

export const TOKEN = "good-token-0123456789";
export const USER = "https://api.calendly.com/users/UUUUUUUUUUUUUUUU";
export const FREE = "https://api.calendly.com/event_types/FREEFREEFREEFREE";
export const PAID = "https://api.calendly.com/event_types/PAIDPAIDPAIDPAID";
export const ROUND = "https://api.calendly.com/event_types/ROUNDROUNDROUND0";

const eventTypes = () => [
  { uri: FREE, name: "30 minute call", active: true, duration: 30, kind: "solo", pooling_type: null, is_paid: false,
    locations: [{ kind: "zoom_conference" }] },
  { uri: PAID, name: "Paid consultation", active: true, duration: 60, kind: "solo", pooling_type: null, is_paid: true, locations: [] },
  { uri: ROUND, name: "Team call", active: true, duration: 30, kind: "solo", pooling_type: "round_robin", is_paid: false, locations: [] },
];

export const slotIso = (ms) => new Date(ms).toISOString().replace(".000Z", ".000000Z");

/** Every open slot between two instants, on India's clock. */
export function openSlots(startMs, endMs) {
  const out = [];
  for (let d = Math.floor((startMs + IST) / DAY); d <= Math.floor((endMs + IST) / DAY); d++) {
    for (const [h, m] of SLOTS) {
      const ms = d * DAY - IST + (h * 60 + m) * 60000;
      if (ms >= startMs && ms <= endMs) out.push(ms);
    }
  }
  return out;
}

export async function startFakeCalendly() {
  const state = { requests: [], taken: new Set(), bookings: [], failNext: null };
  const send = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const body = raw ? JSON.parse(raw) : null;
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { title: "Unauthenticated", message: "The access token is invalid" });

      if (state.failNext && req.method === (state.failNext.method ?? req.method) && url.pathname === (state.failNext.path ?? url.pathname)) {
        const fail = state.failNext; state.failNext = null;
        if (fail.mode === "hang") return;                                    // never answers
        if (fail.mode === "book_then_hang") { state.bookings.push(fail.booking(body)); return; }
        return send(res, fail.status, fail.body ?? { title: "Error", message: "failed on purpose" });
      }

      if (url.pathname === "/users/me") {
        return send(res, 200, { resource: { uri: USER, name: "Dr Mehta", email: "mehta@clinic.in", timezone: "Asia/Kolkata",
          current_organization: "https://api.calendly.com/organizations/OOOOOOOOOOOOOOOO" } });
      }
      if (url.pathname === "/event_types") {
        if (!url.searchParams.get("user") && !url.searchParams.get("organization")) return send(res, 400, { title: "Invalid Argument", message: "user or organization required" });
        return send(res, 200, { collection: eventTypes(), pagination: { count: 3, next_page: null } });
      }
      const one = url.pathname.match(/^\/event_types\/([A-Z0-9]+)$/);
      if (one) {
        const found = eventTypes().find((e) => e.uri.endsWith(one[1]));
        return found ? send(res, 200, { resource: found }) : send(res, 404, { title: "Resource Not Found", message: "The server could not find the requested resource." });
      }
      if (url.pathname === "/event_type_available_times") {
        const start = Date.parse(url.searchParams.get("start_time")), end = Date.parse(url.searchParams.get("end_time"));
        if (!eventTypes().some((e) => e.uri === url.searchParams.get("event_type"))) return send(res, 404, { title: "Resource Not Found", message: "event type" });
        if (!(start > Date.now() - 60000)) return send(res, 400, { title: "Invalid Argument", message: "Date cannot be in the past." });
        if (!(end > start) || end - start > 31 * DAY) return send(res, 400, { title: "Invalid Argument", message: "Date range can be no greater than 31 days." });
        const collection = openSlots(start, end).filter((ms) => !state.taken.has(ms))
          .map((ms) => ({ status: "available", invitees_remaining: 1, start_time: slotIso(ms), scheduling_url: "https://calendly.com/x" }));
        return send(res, 200, { collection });
      }
      if (url.pathname === "/invitees" && req.method === "POST") {
        const ms = Date.parse(body?.start_time);
        if (!eventTypes().some((e) => e.uri === body?.event_type && !e.is_paid)) return send(res, 400, { title: "Invalid Argument", message: "Event types that require payment cannot be scheduled via the API." });
        if (!body?.invitee?.email || !body?.invitee?.timezone || !(body?.invitee?.name || body?.invitee?.first_name)) return send(res, 400, { title: "Invalid Argument", message: "The supplied parameters are invalid." });
        if (!openSlots(ms, ms).length || state.taken.has(ms)) return send(res, 404, { title: "Resource Not Found", message: "The server could not find the requested resource." });
        state.taken.add(ms);
        const booking = { uri: `https://api.calendly.com/scheduled_events/EVT${state.bookings.length}`, start_time: slotIso(ms), status: "active",
          invitee_email: body.invitee.email, event_type: body.event_type, body };
        state.bookings.push(booking);
        return send(res, 201, { resource: { uri: `https://api.calendly.com/scheduled_events/EVT${state.bookings.length - 1}/invitees/III`, email: body.invitee.email,
          name: body.invitee.name, status: "active", timezone: body.invitee.timezone, event: booking.uri, scheduling_method: "api" } });
      }
      if (url.pathname === "/scheduled_events") {
        const email = url.searchParams.get("invitee_email");
        const found = state.bookings.filter((b) => (!email || b.invitee_email === email)
          && Date.parse(b.start_time) >= Date.parse(url.searchParams.get("min_start_time") ?? 0)
          && Date.parse(b.start_time) <= Date.parse(url.searchParams.get("max_start_time") ?? 8.64e15));
        return send(res, 200, { collection: found.map((b) => ({ uri: b.uri, start_time: b.start_time, status: b.status })), pagination: { count: found.length } });
      }
      return send(res, 404, { title: "Resource Not Found", message: "no such thing" });
    });
  });
  await new Promise((resolve) => server.listen(18768, "127.0.0.1", resolve));
  return {
    state,
    reset() { state.requests.length = 0; state.taken.clear(); state.bookings.length = 0; state.failNext = null; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
