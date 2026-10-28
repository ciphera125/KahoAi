import { config } from "../config/env.js";
import * as Agent from "../models/Agent.js";
import * as Call from "../models/Call.js";
import * as Contact from "../models/Contact.js";
import * as PhoneNumber from "../models/PhoneNumber.js";
import { OutsideWindowError, placeCall } from "../services/calling.js";
import { syncFromPlivo } from "../services/plivoSync.js";
import { subscribe } from "../services/liveEvents.js";
import { HttpError, NotFoundError, ValidationError } from "../utils/errors.js";
import { CALL_ID } from "../utils/phone.js";
import { note } from "./notify.js";

async function named(orgId, calls) {
  const [names, people] = await Promise.all([Agent.names(orgId), Contact.namesFor(orgId, calls.map((c) => c.peer))]);
  return calls.map((c) => ({ ...c, agent_name: names[c.agent_id] ?? null, contact_name: people[c.peer] ?? null }));
}

/** Dial `to` from one of the organization's numbers, once. */
export async function place(req, res) {
  const org = req.user.org_id;
  const body = req.body ?? {};
  if (body.consent !== true) throw new ValidationError("confirm that this person has agreed to be called");
  let placed;
  try {
    placed = await placeCall(org, { fromId: body.from_id, to: body.to, agentId: body.agent_id });
  } catch (err) {
    if (err instanceof OutsideWindowError) return res.status(400).json({ error: err.message, code: err.code, call_window: err.window });
    throw err;
  }
  const { to, from, request_uuid: requestUuid, agent } = placed;
  const who = (await Contact.namesFor(org, [to]))[to] ?? to;
  await note(req, "call", `Called ${who}${agent ? ` with ${agent.name}` : ""}`, "calls", requestUuid);
  res.json({ to, from, request_uuid: requestUuid, agent_name: agent?.name ?? null });
}

export async function list(req, res) {
  const org = req.user.org_id;
  const page = await Call.page(org, { page: req.query.page, perPage: req.query.per_page });
  res.json({ ...page, calls: await named(org, page.calls) });
}

export async function forContact(req, res) {
  const org = req.user.org_id;
  const peers = await Contact.numbersOf(org, req.params.contactId);
  const page = await Call.page(org, { page: req.query.page, perPage: req.query.per_page, peers });
  res.json({ ...page, calls: await named(org, page.calls) });
}

export async function transcript(req, res) {
  res.json(await Call.turns(req.user.org_id, req.params.callId));
}

// A spreadsheet runs a cell that starts like a formula; a caller's words must not.
const cell = (text) => {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export async function transcriptCsv(req, res) {
  const turns = await Call.turns(req.user.org_id, req.params.callId);
  const lines = ["time,speaker,text", ...turns.map((t) => [t.at, t.role === "agent" ? "Agent" : "Caller", t.text].map(cell).join(","))];
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="call-${req.params.callId}.csv"`);
  res.send(lines.join("\r\n") + "\r\n");
}

export async function toolCallsList(req, res) {
  res.json(await Call.toolCalls(req.user.org_id, { limit: req.query.limit }));
}

export async function activeCalls(req, res) {
  const calls = await Call.activeCalls(req.user.org_id);
  res.json(await named(req.user.org_id, calls));
}

export async function dashboard(req, res) {
  const days = Number(req.query.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new ValidationError("days must be between 1 and 365");
  const d = await Call.dashboard(req.user.org_id, days);
  res.json({ ...d, recent: await named(req.user.org_id, d.recent) });
}

/** Read how recent calls ended from Plivo's call records (read-only there). */
export async function sync(req, res) {
  const org = req.user.org_id;
  const [authId, authToken] = await PhoneNumber.plivoCredentials(org);
  if (!authId || !authToken) throw new ValidationError("Plivo is not connected; add its credentials on Numbers");
  const ours = (await PhoneNumber.listPublic(org)).filter((n) => n.provider === "plivo").map((n) => n.number);
  const synced = await syncFromPlivo({ authId, authToken, ours: ours[0] ?? null,
    onRecord: (id, fields) => Call.recordOutcome(id, fields, { orgId: org }) });
  res.json({ synced });
}

// Open live streams per user in this process. Each holds a connection and
// polls, so one account (or a stolen session) cannot open thousands.
const openStreams = new Map();

/** Server-sent events from one call's transcript, as they are written. A call
 * placed a moment ago may not have reached the database yet, so an unknown id
 * waits like a ringing call; it only ever streams this organization's lines. */
export async function stream(req, res) {
  const org = req.user.org_id;
  const callId = req.params.callId;
  if (!CALL_ID.test(callId)) throw new ValidationError("not a call id");
  if (!(await Call.owns(org, callId))) throw new NotFoundError("call");
  const userKey = req.user.id;
  if ((openStreams.get(userKey) ?? 0) >= config.MAX_STREAMS_PER_USER) {
    throw new HttpError(429, `at most ${config.MAX_STREAMS_PER_USER} live transcripts open at once; close one first`);
  }
  openStreams.set(userKey, (openStreams.get(userKey) ?? 0) + 1);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
    Connection: "keep-alive" });
  let lastId = 0, done = false, busy = false, again = false, seen = false;
  const timers = [];
  let unsubscribe = () => {};
  const finish = () => {
    if (done) return;
    done = true;
    timers.forEach(clearInterval);
    unsubscribe();
    const n = (openStreams.get(userKey) ?? 1) - 1;
    if (n > 0) openStreams.set(userKey, n); else openStreams.delete(userKey);
    res.end();
  };
  const pump = async () => {
    if (done) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        for (const { id, shown } of await Call.shownEvents(org, callId, lastId)) {
          lastId = id;
          seen = true;
          res.write(`data: ${JSON.stringify(shown)}\n\n`);
          if (shown.event === "call_end") return finish();
        }
      } while (again && !done);
    } catch {
      finish();
    } finally {
      busy = false;
    }
  };
  unsubscribe = subscribe(callId, pump);
  const started = Date.now();
  timers.push(setInterval(pump, 2000)); // a safety net under the notifications
  timers.push(setInterval(() => {
    const secs = (Date.now() - started) / 1000;
    if (!seen && secs >= config.STREAM_WAIT_SECS) {
      res.write(`data: ${JSON.stringify({ event: "no_answer" })}\n\n`);
      return finish();
    }
    if (secs >= config.STREAM_MAX_SECS) return finish();
    res.write(seen ? ": ping\n\n" : ": waiting\n\n");
  }, 1000));
  req.on("close", finish);
  await pump();
}
