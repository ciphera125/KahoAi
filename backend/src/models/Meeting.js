// Booking a meeting on a call, through the organization's own Calendly (owner, 2026-11-22).
//
// Two tools: check_availability reads the free times, book_meeting books one. Calendly then sends its own
// confirmation e-mails to the person booked and to the host, so nothing here sends mail.
//
// What a model says is never trusted: the time it books must be one Calendly itself lists as open a moment
// ago, the e-mail must be well formed and read back to the caller, a booking is made once however many times
// it is asked, and after a timeout nobody retries (the meeting may exist) but looks for it. Every message
// is in plain words the agent can act on, and none carries anything from Calendly's own reply.
import { asSystem } from "../db/pool.js";
import { logger } from "../utils/logger.js";
import { spokenWhen } from "../utils/indiaTime.js";
import * as Calendly from "../services/calendly.js";
import * as OrgSettings from "./OrgSettings.js";
import { parseTaskDue, readTime } from "./answerValue.js";

const DAY = 86400000;
const IST_OFFSET_MS = 19800000;
const TIMEZONE = "Asia/Kolkata";
const AHEAD_DAYS = 60;
const OFFER = 6;
const NAME_MAX = 80;
const SAID_MAX = 400; // nothing a caller says into these tools is longer than this; longer is refused before any work
// A caller can be talked into anything, so booking is limited: a call books at most this many meetings, and one
// e-mail address is booked at most this many times a day across all calls (it would be a way to mail a stranger).
export const MAX_PER_CALL = 2;
export const MAX_PER_EMAIL_PER_DAY = 3;

const no = (message) => ({ ok: false, message });

export const WORDS = {
  cannot: "I cannot do that on this call.",
  notSetUp: "Booking is not set up yet, so I cannot book a meeting. Say someone will confirm a time, and carry on.",
  noType: "I do not know which meeting to book. Say someone will confirm a time, and carry on.",
  paid: "That meeting takes payment, which I cannot book. Say someone will confirm a time.",
  notWorking: "Booking is not working right now. Say someone will confirm a time by e-mail or phone.",
  cannotCheck: "I could not check the free times just now. Try once more, or say someone will confirm a time.",
  past: "That date is in the past. Ask them for a day from today.",
  tooFar: "That is too far ahead to book. Ask for a day in the next two months.",
  notOffered: "That is not one of the times I offered. Check the free times again and use one of them exactly.",
  taken: "That time is no longer free. Check the free times again and offer another time.",
  readBack: "The caller has not heard their e-mail read back yet. Spell it back to them letter by letter and wait for a yes, then book.",
  email: "I did not catch a valid e-mail address. Ask them to say it again slowly, then read it back.",
  name: "I did not catch their name. Ask for it again.",
  limit: "Too many bookings were made today, so I cannot book this one. Say someone will confirm a time.",
  unsure: "I could not confirm the booking. Do not promise it: say someone will confirm by e-mail.",
  place: "I cannot book this kind of meeting, because it asks the caller for a place. Say someone will confirm a time.",
  enough: "Enough meetings have been booked on this call. Say someone will arrange any more.",
  sameEmail: "That e-mail address has already been booked several times today, so I cannot book it again. Say someone will confirm.",
  phone: "I cannot book this meeting because it is a call to their phone and I do not have their number. Say someone will confirm a time.",
};

/** The organization and the person on the other end are decided by the call, never by the model. */
async function context(subject, tool) {
  const { rows } = await asSystem((db) => db.query(
    `SELECT lv.tools, lv.settings FROM agents a JOIN agent_versions lv ON lv.id = a.live_version_id
     WHERE a.id = $1 AND a.org_id = $2`, [subject.agent_id, subject.org_id]));
  if (!rows[0] || !Array.isArray(rows[0].tools) || !rows[0].tools.includes(tool)) return { problem: WORDS.cannot };
  const connection = await OrgSettings.calendlyOf(subject.org_id);
  if (!connection) return { problem: WORDS.notSetUp };
  const meetingType = rows[0].settings?.meeting_type;
  if (!Calendly.isEventTypeUri(meetingType)) return { problem: WORDS.noType };
  return { connection, meetingType };
}

const calendlyProblem = (kind, forBooking = false) => {
  if (kind === "auth" || kind === "scope") return WORDS.notWorking;
  if (kind === "limit") return forBooking ? WORDS.limit : WORDS.cannotCheck;
  if (kind === "gone") return WORDS.notWorking;
  return WORDS.cannotCheck;
};

/** "10 am" as minutes after midnight, or a message when it cannot be read. */
function clockOf(said) {
  const text = String(said ?? "").slice(0, SAID_MAX + 1).toLowerCase().trim();
  if (!text) return { ok: true, minutes: null };
  if (text.length > SAID_MAX) return { ok: false, message: "I did not catch the time. Please ask for it again, like 5 in the evening." };
  const t = readTime(text);
  if (t.invalid || (!t.found && !t.ambiguous)) return { ok: false, message: "I did not catch the time. Please ask for it again, like 5 in the evening." };
  if (t.ambiguous) return { ok: false, message: "That time could be in the morning or the evening. Please ask which they mean." };
  return { ok: true, minutes: t.hour * 60 + t.minute };
}
const minutesOf = (ms) => { const d = new Date(ms + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

export async function checkAvailability(subject, args) {
  const ctx = await context(subject, "check_availability");
  if (ctx.problem) return no(ctx.problem);
  const { token } = ctx.connection;

  const now = Date.now();
  let from = now + 5 * 60000;
  let to = from + 7 * DAY;
  if (String(args.day ?? "").trim()) {
    if (String(args.day).length > SAID_MAX) return no("I did not catch the date. Please ask for the exact date, like the fifteenth of December.");
    const read = parseTaskDue(String(args.day), { now: new Date() });
    if (!read.ok) return no(read.message);
    const dayStart = Date.parse(`${read.day}T00:00:00+05:30`);
    if (!(dayStart + DAY > now)) return no(WORDS.past);
    if (dayStart > now + AHEAD_DAYS * DAY) return no(WORDS.tooFar);
    from = Math.max(dayStart, now + 5 * 60000);
    to = dayStart + DAY - 1;
  }
  const after = clockOf(args.after);
  if (!after.ok) return no(after.message);
  const before = clockOf(args.before);
  if (!before.ok) return no(before.message);

  const type = await Calendly.eventType(token, ctx.meetingType);
  if (!type.ok) return no(calendlyProblem(type.kind));
  if (type.type.paid) return no(WORDS.paid);

  const listed = await Calendly.availableTimes(token, ctx.meetingType, from, to);
  if (!listed.ok) return no(calendlyProblem(listed.kind));
  const slots = listed.times
    .filter((ms) => (after.minutes === null || minutesOf(ms) >= after.minutes) && (before.minutes === null || minutesOf(ms) <= before.minutes))
    .slice(0, OFFER)
    .map((ms) => ({ start: new Date(ms).toISOString(), when: spokenWhen(new Date(ms)) }));
  const meeting = `${type.type.name}${type.type.duration ? `, ${type.type.duration} minutes` : ""}`;
  if (slots.length === 0) {
    return { ok: true, slots: [], count: 0, meeting, message: "There is no free time in that window. Offer another day or another part of the day." };
  }
  return { ok: true, slots, count: slots.length, meeting,
    note: "Offer at most three of these, saying the times in words from `when`. When they choose, book with that slot's `start`, exactly as written." };
}

// --- e-mail and name ---------------------------------------------------------------------------------------

const EMAIL = /^[^\s@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** An e-mail as it was typed, or as it was said ("ravi dot kumar at the rate gmail dot com"). Null if it is not one. */
export function readEmail(said) {
  if (typeof said !== "string" || said.length > SAID_MAX) return null;
  let text = said.trim().toLowerCase();
  if (!text) return null;
  if (!text.includes("@")) {
    text = text.replace(/\s+(?:at the rate of|at the rate|at-the-rate|एट द रेट)\s+/g, "@").replace(/\s+at\s+/g, "@")
      .replace(/\s+(?:dot|डॉट)\s+/g, ".").replace(/\s+underscore\s+/g, "_").replace(/\s+(?:dash|hyphen)\s+/g, "-").replace(/\s+/g, "");
  }
  return text.length <= 254 && EMAIL.test(text) ? text : null;
}

export function cleanName(said) {
  if (typeof said !== "string" || said.length > SAID_MAX) return null;
  const text = [...said.replace(/\s+/g, " ")].filter((ch) => ch.codePointAt(0) >= 32 && ch.codePointAt(0) !== 127 && ch !== "<" && ch !== ">").join("").trim();
  return text && [...text].length <= NAME_MAX ? text : null;
}

// --- where the meeting happens -----------------------------------------------------------------------------

const NEEDS_NO_PLACE = new Set(["zoom_conference", "google_conference", "gotomeeting_conference", "microsoft_teams_conference", "webex_conference", "inbound_call"]);

/** The location Calendly wants, which must match the one the meeting type is set to. */
function locationFor(type, peer) {
  if (type.roundRobin || type.locations.length === 0) return { ok: true, location: null };
  const choice = type.locations.find((l) => l?.kind && l.kind !== "ask_invitee");
  if (!choice) return { ok: false, message: WORDS.place };
  if (NEEDS_NO_PLACE.has(choice.kind)) return { ok: true, location: { kind: choice.kind } };
  if (choice.kind === "outbound_call") {
    return /^\+\d{8,15}$/.test(String(peer ?? "")) ? { ok: true, location: { kind: "outbound_call", location: peer } } : { ok: false, message: WORDS.phone };
  }
  if ((choice.kind === "physical" || choice.kind === "custom") && typeof choice.location === "string" && choice.location) {
    return { ok: true, location: { kind: choice.kind, location: choice.location } };
  }
  return { ok: false, message: WORDS.place };
}

// --- booking ------------------------------------------------------------------------------------------------

async function recorded(subject, startMs) {
  const { rows } = await asSystem((db) => db.query(
    "SELECT invitee_email FROM meeting_bookings WHERE call_id = $1 AND org_id = $2 AND start_time = $3",
    [subject.call_id, subject.org_id, new Date(startMs)]));
  return rows[0] ?? null;
}

async function record(subject, { meetingType, startMs, name, email, eventUri }) {
  try {
    await asSystem((db) => db.query(
      `INSERT INTO meeting_bookings (org_id, call_id, agent_id, event_type, start_time, invitee_name, invitee_email, calendly_event)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (call_id, start_time) DO NOTHING`,
      [subject.org_id, subject.call_id, subject.agent_id, meetingType, new Date(startMs), name, email, eventUri]));
  } catch (err) {
    // The meeting exists at Calendly; failing to note it here must not tell the caller it did not happen.
    logger.warn({ err: err.message }, "a booked meeting could not be written down");
  }
}

const booked = (startMs, email, extra = {}) => ({ ok: true, booked: true, when: spokenWhen(new Date(startMs)), email, ...extra,
  message: "Booked. They will get a confirmation e-mail from Calendly at the address they gave." });

export async function bookMeeting(subject, args) {
  const ctx = await context(subject, "book_meeting");
  if (ctx.problem) return no(ctx.problem);
  const { token, userUri } = ctx.connection;

  const startMs = typeof args.start === "string" && /^\d{4}-\d\d-\d\dT/.test(args.start) ? Date.parse(args.start) : NaN;
  const now = Date.now();
  if (!Number.isFinite(startMs) || startMs <= now || startMs > now + AHEAD_DAYS * DAY) return no(WORDS.notOffered);

  // Asked again (the same turn, or the next): the meeting is already made.
  const already = await recorded(subject, startMs);
  if (already) return booked(startMs, already.invitee_email, { already: true });

  if (args.email_confirmed !== true) return no(WORDS.readBack);
  const email = readEmail(args.email);
  if (!email) return no(WORDS.email);
  const name = cleanName(args.invitee_name);
  if (!name) return no(WORDS.name);

  const { rows: [counts] } = await asSystem((db) => db.query(
    `SELECT count(*) FILTER (WHERE call_id = $2)::int AS on_call,
            count(*) FILTER (WHERE invitee_email = $3 AND created_at > now() - interval '24 hours')::int AS to_email
       FROM meeting_bookings WHERE org_id = $1`, [subject.org_id, subject.call_id, email]));
  if (counts.on_call >= MAX_PER_CALL) return no(WORDS.enough);
  if (counts.to_email >= MAX_PER_EMAIL_PER_DAY) return no(WORDS.sameEmail);

  const type = await Calendly.eventType(token, ctx.meetingType);
  if (!type.ok) return no(calendlyProblem(type.kind, true));
  if (type.type.paid) return no(WORDS.paid);
  const where = locationFor(type.type, subject.peer);
  if (!where.ok) return no(where.message);

  // Only a time Calendly itself lists as open right now: a time the model made up never reaches the booking.
  const open = await Calendly.availableTimes(token, ctx.meetingType, startMs, startMs + 3600000);
  if (!open.ok) return no(calendlyProblem(open.kind, true));
  if (!open.times.includes(startMs)) return no(WORDS.taken);

  const made = await Calendly.invite(token, { eventTypeUri: ctx.meetingType, startMs, name, email, timezone: TIMEZONE, location: where.location });
  if (made.ok) {
    await record(subject, { meetingType: ctx.meetingType, startMs, name, email, eventUri: made.eventUri });
    return booked(startMs, email);
  }
  if (made.kind === "auth" || made.kind === "scope") return no(WORDS.notWorking);
  if (made.kind === "limit") return no(WORDS.limit);
  if (made.kind === "gone" || made.kind === "invalid") return no(WORDS.taken);

  // A timeout or a server error: the meeting may or may not exist. Look, never ask again.
  const found = await Calendly.findBooking(token, { userUri, email, startMs });
  if (found.ok && found.found) {
    await record(subject, { meetingType: ctx.meetingType, startMs, name, email, eventUri: found.eventUri });
    return booked(startMs, email);
  }
  return no(WORDS.unsure);
}
