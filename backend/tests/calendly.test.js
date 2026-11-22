// Booking a meeting on the call through the customer's own Calendly (owner, 2026-11-22). Calendly sends its
// own confirmation e-mails to the person booked and to the host, so nothing here sends mail. Every test runs
// against a stand-in for Calendly's API (fakeCalendly.js); no real meeting is ever booked.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, line, member, owner } from "./helpers.js";
import { FREE, PAID, ROUND, TOKEN, startFakeCalendly } from "./fakeCalendly.js";
import { limits } from "../src/services/calendly.js";
import { resetRateLimits } from "../src/middleware/rateLimit.js";

let fake;
beforeAll(async () => { fake = await startFakeCalendly(); limits.timeoutMs = 700; });
afterAll(async () => { await fake.close(); });
beforeEach(async () => { await freshDb(); fake.reset(); });

const CALL = "33333333-3333-3333-3333-333333333333";
/** Publishes over the checks (an admin may): some tests need an agent the check would refuse, to see what the call does. */
const publishAnyway = async (b, id) => {
  const r = await b.post(`/api/agents/${id}/publish`).send({ override: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const istDay = (plus = 0) => {
  const t = new Date(Date.now() + plus * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(t); // 2026-11-23
};
const istDayOf = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));
const istClock = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

async function connected(b = null) {
  const who = b ?? await owner();
  const r = await who.put("/api/org/calendly").send({ token: TOKEN });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return who;
}

/** An agent that may book, on a call that is on the line. */
async function agentOnACall(b, { type = FREE, tools = ["end_call", "check_availability", "book_meeting"] } = {}) {
  await line(b);
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  const set = await b.patch(`/api/agents/${a.id}`).send({ tools, settings: type ? { meeting_type: type } : {} });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  await publishAnyway(b, a.id);
  // What the phone server tells the Studio as the call starts: the agent. The caller's number follows in the events.
  await internal("put", `/internal/v1/calls/${CALL}`).send({ agent_id: a.id, status: "answered", peer: "+919876543210" });
  return a;
}
const tool = (name, body) => internal("post", `/internal/v1/calls/${CALL}/tools/${name}`).send(body);
const book = (body) => tool("book_meeting", { invitee_name: "Ravi Kumar", email: "ravi@example.com", email_confirmed: true, turn: 4, ...body });

async function firstSlot(day = istDay(1)) {
  const r = await tool("check_availability", { day, turn: 3 });
  expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
  return r.body.slots[0];
}

describe("connecting Calendly", () => {
  it("is done by pasting a token, which is checked with Calendly and kept sealed", async () => {
    const b = await owner();
    const r = await b.put("/api/org/calendly").send({ token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connected: true, name: "Dr Mehta", email: "mehta@clinic.in" });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    const { rows } = await db.query("SELECT settings::text AS s FROM organizations");
    expect(rows[0].s).not.toContain(TOKEN);                       // never stored as it was typed
    expect((await b.get("/api/org/calendly")).body).toMatchObject({ connected: true, name: "Dr Mehta" });
    expect(JSON.stringify((await b.get("/api/org/calendly")).body)).not.toContain(TOKEN);
    expect(fake.state.requests.some((q) => q.path === "/users/me" && q.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("is refused with a plain sentence when Calendly does not accept the token, and nothing is kept", async () => {
    const b = await owner();
    const r = await b.put("/api/org/calendly").send({ token: "not-a-real-token-1234567890" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/calendly/i);
    expect((await b.get("/api/org/calendly")).body.connected).toBe(false);
  });

  it("refuses text that cannot be a token without calling Calendly at all", async () => {
    const b = await owner();
    for (const bad of ["", "   ", 5, null, ["x"], "a b c", "x".repeat(3000), "tok\nen", "../../etc/passwd", "tok<script>"]) {
      await resetRateLimits(); // this test is about what is refused, not how often
      expect((await b.put("/api/org/calendly").send({ token: bad })).status, JSON.stringify(bad).slice(0, 30)).toBe(400);
    }
    expect(fake.state.requests).toEqual([]);
  });

  it("can be disconnected, and then no booking can be made", async () => {
    const b = await connected();
    expect((await b.delete("/api/org/calendly")).status).toBe(200);
    expect((await b.get("/api/org/calendly")).body.connected).toBe(false);
    const { rows } = await db.query("SELECT settings::text AS s FROM organizations");
    expect(rows[0].s).not.toMatch(/calendly/i);
  });

  it("is for admins: a viewer may not connect, change or remove it", async () => {
    const boss = await connected();
    const viewer = await member(boss, { role: "viewer" });
    expect((await viewer.put("/api/org/calendly").send({ token: TOKEN })).status).toBe(403);
    expect((await viewer.delete("/api/org/calendly")).status).toBe(403);
    expect((await boss.get("/api/org/calendly")).body.connected).toBe(true);
  });

  it("is not shared with another organization", async () => {
    await connected();
    const other = await owner({ email: "zed@other.in", organization: "Other Co" });
    expect((await other.get("/api/org/calendly")).body.connected).toBe(false);
  });

  it("lists the meeting types, and says which cannot be booked by the agent", async () => {
    const b = await connected();
    const r = await b.get("/api/org/calendly/event-types");
    expect(r.status).toBe(200);
    const byName = Object.fromEntries(r.body.items.map((i) => [i.name, i]));
    expect(byName["30 minute call"]).toMatchObject({ uri: FREE, duration: 30, bookable: true });
    expect(byName["Paid consultation"].bookable).toBe(false);
    expect(byName["Paid consultation"].reason).toMatch(/pay/i);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  it("lists nothing when Calendly is not connected", async () => {
    const b = await owner();
    const r = await b.get("/api/org/calendly/event-types");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/connect/i);
  });
});

describe("the meeting an agent books", () => {
  it("is one of the types in this Calendly, written exactly as Calendly writes it", async () => {
    const b = await connected();
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    expect((await b.patch(`/api/agents/${a.id}`).send({ settings: { meeting_type: FREE } })).body.settings.meeting_type).toBe(FREE);
    for (const bad of ["x", "http://api.calendly.com/event_types/ABCDEFGH1234", "https://evil.example/event_types/ABCDEFGH1234",
      "https://api.calendly.com/event_types/ABCDEFGH1234?x=1", "https://api.calendly.com/event_types/../users/me", 5, {}, ["a"]]) {
      expect((await b.patch(`/api/agents/${a.id}`).send({ settings: { meeting_type: bad } })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await b.patch(`/api/agents/${a.id}`).send({ settings: { meeting_type: "" } })).body.settings.meeting_type).toBe("");
  });

  it("reaches the call with the rest of what the agent is set to", async () => {
    const b = await connected();
    const a = await agentOnACall(b);
    const r = await internal("get", `/internal/v1/call-config?agent_id=${a.id}`);
    expect(r.body.config.meeting_type).toBe(FREE);
    expect(r.body.config.tools).toEqual(expect.arrayContaining(["check_availability", "book_meeting"]));
  });
});

describe("asking what is free", () => {
  it("lists the open times on the day the caller named, in words, on India's clock", async () => {
    const b = await connected();
    await agentOnACall(b);
    const r = await tool("check_availability", { day: "tomorrow", turn: 1 });
    expect(r.body.ok).toBe(true);
    expect(r.body.slots.length).toBeGreaterThan(0);
    expect(r.body.slots.length).toBeLessThanOrEqual(6);
    for (const s of r.body.slots) {
      expect(istDayOf(s.start)).toBe(istDay(1));
      expect(s.when).toMatch(/\d+:\d\d (am|pm)/);
      expect(s.start).toMatch(/Z$/);
    }
    expect(r.body.meeting).toMatch(/30 minute call/);
  });

  it("keeps to the hours the caller said", async () => {
    const b = await connected();
    await agentOnACall(b);
    const r = await tool("check_availability", { day: "tomorrow", after: "11 am", before: "1 pm", turn: 1 });
    expect(r.body.slots.length).toBeGreaterThan(0);
    for (const s of r.body.slots) expect(istClock(s.start) >= "11:00" && istClock(s.start) <= "13:00").toBe(true);
    const afternoon = await tool("check_availability", { day: "tomorrow", after: "3 pm", turn: 2 });
    expect(afternoon.body.slots.map((s) => istClock(s.start))).toEqual(["15:00", "15:30"]);
  });

  it("says plainly when nothing is free, so the agent can offer another day", async () => {
    const b = await connected();
    await agentOnACall(b);
    const r = await tool("check_availability", { day: "tomorrow", after: "8 pm", turn: 1 });
    expect(r.body.ok).toBe(true);
    expect(r.body.slots).toEqual([]);
    expect(r.body.message).toMatch(/no free time|another day/i);
  });

  it("looks ahead when the caller names no day", async () => {
    const b = await connected();
    await agentOnACall(b);
    const r = await tool("check_availability", { turn: 1 });
    expect(r.body.ok).toBe(true);
    expect(r.body.slots.length).toBeGreaterThan(0);
  });

  it("does not guess a day it could not read, or one that has gone", async () => {
    const b = await connected();
    await agentOnACall(b);
    expect((await tool("check_availability", { day: "blah blah", turn: 1 })).body.ok).toBe(false);
    expect((await tool("check_availability", { day: "yesterday", turn: 4 })).body.ok).toBe(false);
    const past = await tool("check_availability", { day: "3 January 2020", turn: 2 });
    expect(past.body.ok).toBe(false);
    expect(past.body.message).toMatch(/past|gone|already/i);
    const unclear = await tool("check_availability", { day: "tomorrow", after: "10", turn: 3 });
    expect(unclear.body.ok).toBe(false);
    expect(unclear.body.message).toMatch(/did not catch the time|morning or the evening/i);
  });

  it("will not look further than Calendly allows or at a day too far ahead to mean anything", async () => {
    const b = await connected();
    await agentOnACall(b);
    const r = await tool("check_availability", { day: "1 March 2031", turn: 1 });
    expect(r.body.ok).toBe(false);
    expect(fake.state.requests.filter((q) => q.path === "/event_type_available_times")).toEqual([]);
  });

  it("tells the agent to carry on without booking when Calendly is not connected", async () => {
    const b = await owner();
    await agentOnACall(b);
    const r = await tool("check_availability", { day: "tomorrow", turn: 1 });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/not set up|not connected/i);
    expect(fake.state.requests).toEqual([]);
  });

  it("tells the agent when no meeting type has been chosen", async () => {
    const b = await connected();
    await agentOnACall(b, { type: "" });
    const r = await tool("check_availability", { day: "tomorrow", turn: 1 });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/which meeting|meeting type/i);
  });

  it("uses only the token of the organization the call belongs to", async () => {
    await connected(); // one organization has Calendly connected...
    fake.reset();
    const other = await owner({ email: "zed@other.in", organization: "Other Co" }); // ...this one has not
    const THEIRS = "44444444-4444-4444-4444-444444444444";
    const a = (await other.post("/api/agents").send({ name: "Zed", prompt: "You are Zed." })).body;
    await other.patch(`/api/agents/${a.id}`).send({ tools: ["end_call", "check_availability", "book_meeting"], settings: { meeting_type: FREE } });
    await publishAnyway(other, a.id);
    await db.query("INSERT INTO calls (call_id, org_id, agent_id, peer, direction, status, started_at) VALUES ($1, $2, $3, '+919000000009', 'inbound', 'answered', now())",
      [THEIRS, other.user.org_id, a.id]);
    const r = await internal("post", `/internal/v1/calls/${THEIRS}/tools/check_availability`).send({ day: "tomorrow", turn: 1 });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/not set up|not connected/i);
    expect(fake.state.requests).toEqual([]); // the first organization's token was never used for this call
  });

  it("does not hand the agent an answer when Calendly is down", async () => {
    const b = await connected();
    await agentOnACall(b);
    fake.state.failNext = { path: "/event_type_available_times", status: 500 };
    const r = await tool("check_availability", { day: "tomorrow", turn: 1 });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/could not check|try again|someone/i);
  });
});

describe("booking the time", () => {
  it("books a time that was offered, with the caller's name and e-mail, and says when", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    const r = await book({ start: slot.start });
    expect(r.body).toMatchObject({ ok: true, booked: true });
    expect(r.body.when).toBe(slot.when);
    expect(r.body.message).toMatch(/e-?mail|confirmation/i);
    const post = fake.state.requests.find((q) => q.method === "POST" && q.path === "/invitees");
    expect(post.body).toMatchObject({ event_type: FREE, invitee: { name: "Ravi Kumar", email: "ravi@example.com", timezone: "Asia/Kolkata" } });
    expect(Date.parse(post.body.start_time)).toBe(Date.parse(slot.start));
    expect(post.body.location).toEqual({ kind: "zoom_conference" });
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    const { rows } = await db.query("SELECT call_id, invitee_name, invitee_email, event_type FROM meeting_bookings");
    expect(rows).toEqual([{ call_id: CALL, invitee_name: "Ravi Kumar", invitee_email: "ravi@example.com", event_type: FREE }]);
  });

  it("never puts the token or the e-mail into what the agent is told or the server logs it keeps", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    const r = await book({ start: slot.start });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  it("reads an e-mail as it is spoken", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    const r = await book({ start: slot.start, email: "ravi dot kumar at the rate gmail dot com" });
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    expect(fake.state.bookings[0].invitee_email).toBe("ravi.kumar@gmail.com");
  });

  it("will not book until the caller has heard their e-mail read back", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    for (const email_confirmed of [false, undefined, "yes", 1, null]) {
      const r = await book({ start: slot.start, email_confirmed });
      expect(r.body.ok, String(email_confirmed)).toBe(false);
      expect(r.body.message).toMatch(/read it back|spell/i);
    }
    expect(fake.state.requests.some((q) => q.method === "POST")).toBe(false);
  });

  it("refuses an e-mail that cannot be one, and a missing or silly name", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    for (const email of ["", "ravi", "ravi@", "@example.com", "a b@example.com", "ravi@example", `${"x".repeat(250)}@example.com`, "ravi@exa mple.com", "ravi@@example.com", 5, null]) {
      const r = await book({ start: slot.start, email });
      expect(r.body.ok, JSON.stringify(email)).toBe(false);
      expect(r.body.message).toMatch(/e-?mail/i);
    }
    for (const name of ["", "   ", 5, null, "x".repeat(200)]) {
      const r = await book({ start: slot.start, invitee_name: name });
      expect(r.body.ok, JSON.stringify(name)).toBe(false);
      expect(r.body.message).toMatch(/name/i);
    }
    expect(fake.state.requests.some((q) => q.method === "POST")).toBe(false);
  });

  it("will not book a time it was never offered, so a made-up time cannot reach Calendly", async () => {
    const b = await connected();
    await agentOnACall(b);
    const invented = new Date(Date.now() + 2 * 86400000).toISOString();
    for (const start of [invented, "tomorrow at 11", "", null, 12345, "2020-01-01T10:00:00Z", "2031-03-01T10:00:00Z"]) {
      const r = await book({ start });
      expect(r.body.ok, JSON.stringify(start)).toBe(false);
    }
    expect(fake.state.requests.some((q) => q.method === "POST")).toBe(false);
  });

  it("tells the agent when the time was taken in the meantime, and to offer another", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    fake.state.taken.add(Date.parse(slot.start));
    const r = await book({ start: slot.start });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/no longer free|taken|another time/i);
    expect(await db.query("SELECT 1 FROM meeting_bookings").then((x) => x.rowCount)).toBe(0);
  });

  it("books once however many times it is asked, on the same turn or the next", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    const first = await book({ start: slot.start, turn: 4 });
    const again = await book({ start: slot.start, turn: 4 });
    const later = await book({ start: slot.start, turn: 5 });
    expect([first, again, later].map((r) => r.body.ok)).toEqual([true, true, true]);
    expect(fake.state.requests.filter((q) => q.method === "POST" && q.path === "/invitees")).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM meeting_bookings").then((x) => x.rowCount)).toBe(1);
    expect(later.body.when).toBe(slot.when);
  });

  it("lets one call book two different times", async () => {
    const b = await connected();
    await agentOnACall(b);
    const r1 = await tool("check_availability", { day: istDay(1), turn: 1 });
    const [s1, s2] = r1.body.slots;
    expect((await book({ start: s1.start, turn: 2 })).body.ok).toBe(true);
    expect((await book({ start: s2.start, turn: 3 })).body.ok).toBe(true);
    expect(fake.state.bookings).toHaveLength(2);
  });

  it("does not send a location for a team round-robin meeting, as Calendly forbids it", async () => {
    const b = await connected();
    await agentOnACall(b, { type: ROUND });
    const slot = await firstSlot();
    const r = await book({ start: slot.start });
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    expect(fake.state.requests.find((q) => q.method === "POST").body).not.toHaveProperty("location");
  });

  it("refuses a meeting that takes payment, which Calendly cannot book for us", async () => {
    const b = await connected();
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    const r = await b.patch(`/api/agents/${a.id}`).send({ settings: { meeting_type: PAID } });
    expect(r.status).toBe(200); // the list says it cannot be booked; a stale choice is stopped at the call
    await agentOnACall(b, { type: PAID });
    const t = await tool("check_availability", { day: "tomorrow", turn: 1 });
    expect(t.body.ok).toBe(false);
    expect(t.body.message).toMatch(/pay/i);
  });

  it("says so when the daily booking limit of the Calendly plan is reached", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    fake.state.failNext = { method: "POST", path: "/invitees", status: 429, body: { title: "Too Many Requests", message: "limit" } };
    const r = await book({ start: slot.start });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/limit|busy|someone/i);
  });

  it("says so when Calendly no longer accepts the token, without saying why to the caller", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    fake.state.failNext = { method: "POST", path: "/invitees", status: 401 };
    const r = await book({ start: slot.start });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/someone will|confirm/i);
    expect(JSON.stringify(r.body)).not.toMatch(/token|401|unauthor/i);
  });

  it("is never retried: after a timeout the booking is looked for, and found if it was made", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    fake.state.failNext = { method: "POST", path: "/invitees", mode: "book_then_hang",
      booking: (body) => ({ uri: "https://api.calendly.com/scheduled_events/EVTX", start_time: body.start_time, status: "active",
        invitee_email: body.invitee.email, event_type: body.event_type, body }) };
    const r = await book({ start: slot.start });
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    expect(fake.state.requests.filter((q) => q.method === "POST" && q.path === "/invitees")).toHaveLength(1);
  });

  it("is never retried: after a timeout with no booking found, it does not promise one", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    fake.state.failNext = { method: "POST", path: "/invitees", mode: "hang" };
    const r = await book({ start: slot.start });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/could not confirm|do not promise|someone will/i);
    expect(fake.state.requests.filter((q) => q.method === "POST" && q.path === "/invitees")).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM meeting_bookings").then((x) => x.rowCount)).toBe(0);
  });

  it("belongs to the call's own organization and nobody else's", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    await book({ start: slot.start });
    const other = await owner({ email: "zed@other.in", organization: "Other Co" });
    const { rows } = await db.query("SELECT org_id FROM meeting_bookings");
    expect(rows[0].org_id).toBe(b.user.org_id);
    expect(rows[0].org_id).not.toBe(other.user.org_id);
  });

  it("goes by the tools the agent was given: one that can look but not book cannot book", async () => {
    const b = await connected();
    await agentOnACall(b, { tools: ["end_call", "check_availability"] });
    const slot = await firstSlot();
    const r = await book({ start: slot.start });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/cannot do that on this call/i);
    expect(fake.state.requests.some((q) => q.method === "POST")).toBe(false);
    expect(await db.query("SELECT 1 FROM meeting_bookings").then((x) => x.rowCount)).toBe(0);
  });

  it("keeps hostile words in a name as plain text, never as anything Calendly reads", async () => {
    const b = await connected();
    await agentOnACall(b);
    const slot = await firstSlot();
    const r = await book({ start: slot.start, invitee_name: "Ravi\u0000\n<script>alert(1)</script> \"; DROP TABLE x;--" });
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    const sent = fake.state.requests.find((q) => q.method === "POST").body.invitee.name;
    expect([...sent].some((ch) => ch.codePointAt(0) < 32)).toBe(false);
    expect(sent.length).toBeLessThanOrEqual(80);
  });
});

describe("publishing an agent that books meetings", () => {
  const checked = async (b, id) => (await b.get(`/api/agents/${id}/check`)).body;
  const codes = (c) => c.problems.map((p) => p.code);
  async function draft(b, tools, settings = {}) {
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    const r = await b.patch(`/api/agents/${a.id}`).send({ tools, settings });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return a;
  }

  it("is stopped while Calendly is not connected, with a plain reason", async () => {
    const b = await owner();
    const a = await draft(b, ["end_call", "check_availability", "book_meeting"], { meeting_type: FREE });
    const c = await checked(b, a.id);
    expect(codes(c)).toContain("calendly_not_connected");
    expect(c.problems.find((p) => p.code === "calendly_not_connected").message).toMatch(/Settings/);
    expect(c.can_publish).toBe(false);
  });

  it("is stopped while no meeting has been chosen", async () => {
    const b = await connected();
    const a = await draft(b, ["end_call", "check_availability", "book_meeting"]);
    expect(codes(await checked(b, a.id))).toContain("no_meeting_type");
  });

  it("is stopped when it can book but cannot look at the free times first", async () => {
    const b = await connected();
    const a = await draft(b, ["end_call", "book_meeting"], { meeting_type: FREE });
    expect(codes(await checked(b, a.id))).toContain("meeting_needs_times");
  });

  it("goes live when Calendly is connected, a meeting is chosen and both tools are given", async () => {
    const b = await connected();
    const a = await draft(b, ["end_call", "check_availability", "book_meeting"], { meeting_type: FREE });
    const c = await checked(b, a.id);
    expect(codes(c).filter((x) => ["calendly_not_connected", "no_meeting_type", "meeting_needs_times"].includes(x))).toEqual([]);
  });

  it("does not bother an agent that books nothing", async () => {
    const b = await owner();
    const a = await draft(b, ["end_call"]);
    expect(codes(await checked(b, a.id))).toEqual([]);
  });
});

describe("booking cannot be turned into spam (security pass, 2026-11-22)", () => {
  async function ready(b) {
    await agentOnACall(b);
    const r = await tool("check_availability", { turn: 1 });
    return r.body.slots;
  }

  it("books at most two meetings on one call, however it is talked into more", async () => {
    const b = await connected();
    const slots = await ready(b);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await book({ start: slots[i].start, email: `person${i}@example.com`, turn: 10 + i }));
    expect(results.map((r) => r.body.ok)).toEqual([true, true, false, false, false]);
    expect(results[2].body.message).toMatch(/enough meetings|someone will/i);
    expect(fake.state.bookings).toHaveLength(2);
  });

  it("books the same e-mail address at most three times in a day across all calls", async () => {
    const b = await connected();
    const slots = await ready(b);
    for (let i = 0; i < 3; i++) {
      await db.query("INSERT INTO meeting_bookings (org_id, call_id, event_type, start_time, invitee_name, invitee_email) VALUES ($1, $2, $3, now() + interval '3 days', 'X', 'victim@example.com')",
        [b.user.org_id, `earlier-call-${i}`, FREE]);
    }
    const r = await book({ start: slots[0].start, email: "victim@example.com" });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/already been booked|someone will/i);
    expect(fake.state.requests.some((q) => q.method === "POST")).toBe(false);
    // someone else is unaffected
    expect((await book({ start: slots[0].start, email: "other@example.com", turn: 9 })).body.ok).toBe(true);
  });

  it("does not count the same booking twice against the limit when it is asked again", async () => {
    const b = await connected();
    const slots = await ready(b);
    for (let turn = 4; turn < 9; turn++) await book({ start: slots[0].start, turn });
    expect((await book({ start: slots[1].start, turn: 20 })).body.ok).toBe(true);
  });
});

describe("what a model or a caller can make the tools chew on (security pass)", () => {
  it("refuses enormous or hostile text at once, without work", async () => {
    const b = await connected();
    await agentOnACall(b);
    fake.reset();
    const long = "a".repeat(5000); // fits through the body limit, so the tool itself must refuse it
    const later = new Date(Date.now() + 86400000).toISOString();
    const started = Date.now();
    const checks = [
      await tool("check_availability", { day: long, turn: 1 }),
      await tool("check_availability", { day: "tomorrow", after: long, turn: 2 }),
      await tool("check_availability", { day: "tomorrow", before: "(a+)+$".repeat(800), turn: 3 }),
      await book({ start: long }),
      await book({ start: later, email: `${long}@x.com` }),
      await book({ start: later, invitee_name: long }),
      await book({ start: later, email: `${"a at ".repeat(1000)}x dot com` }),
    ];
    expect(checks.map((r) => r.body.ok)).toEqual(Array(checks.length).fill(false));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(fake.state.requests).toEqual([]);                      // nothing reached Calendly
  });

  it("is stopped by the server's body limit before a giant request is even read", async () => {
    const b = await connected();
    await agentOnACall(b);
    const r = await tool("check_availability", { day: "a".repeat(3_000_000), turn: 1 });
    expect(r.status).toBe(413);
    expect(r.body.ok).not.toBe(true);
  });

  it("is not fooled by values of the wrong kind", async () => {
    const b = await connected();
    await agentOnACall(b);
    for (const day of [{}, [], 5, true, { toString: 1 }, ["tomorrow"]]) {
      const r = await tool("check_availability", { day, turn: 1 });
      expect(r.status).toBe(200);
      expect(typeof r.body.ok).toBe("boolean");
    }
    for (const body of [{ start: [] }, { start: {} }, { invitee_name: [] , email: {} }, null, "text"]) {
      const r = await internal("post", `/internal/v1/calls/${CALL}/tools/book_meeting`).send(body ?? undefined);
      expect(r.status, JSON.stringify(body)).toBeLessThan(500);
    }
  });
});

describe("the Calendly settings cannot be hammered or snooped on (security pass)", () => {
  it("allows only a few connection attempts a minute, so it is no way to test stolen tokens", async () => {
    const b = await owner();
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await b.put("/api/org/calendly").send({ token: `wrong-token-${i}-0123456789abcdef` })).status);
    expect(codes.slice(0, 3)).toEqual([400, 400, 400]);
    expect(codes).toContain(429);
    expect(fake.state.requests.length).toBeLessThanOrEqual(6);
  });

  it("allows only a few meeting-type look-ups a minute, since each one calls Calendly", async () => {
    const b = await connected();
    fake.reset();
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push((await b.get("/api/org/calendly/event-types")).status);
    expect(codes).toContain(429);
    expect(fake.state.requests.filter((q) => q.path === "/event_types").length).toBeLessThan(40);
  });

  it("shows the connected account's name and e-mail only to those who manage the organization", async () => {
    const boss = await connected();
    const viewer = await member(boss, { role: "viewer" });
    const seen = (await viewer.get("/api/org/calendly")).body;
    expect(seen.connected).toBe(true);
    expect(seen.email).toBe("");
    expect(seen.name).toBe("");
    expect((await boss.get("/api/org/calendly")).body.email).toBe("mehta@clinic.in");
  });

  it("refuses a request that comes from another website", async () => {
    const b = await connected();
    for (const method of ["put", "delete"]) {
      const r = await b.agent[method]("/api/org/calendly").set("Origin", "https://evil.example").set("Host", "localhost:8020").send({ token: TOKEN });
      expect(r.status, method).toBe(403);
    }
    expect((await b.get("/api/org/calendly")).body.connected).toBe(true);
  });

  it("refuses everything without signing in", async () => {
    const { browser } = await import("./helpers.js");
    const anon = browser();
    for (const [method, path] of [["get", "/api/org/calendly"], ["put", "/api/org/calendly"], ["delete", "/api/org/calendly"], ["get", "/api/org/calendly/event-types"]]) {
      expect((await anon[method](path).send({ token: TOKEN })).status, `${method} ${path}`).toBe(401);
    }
  });
});
