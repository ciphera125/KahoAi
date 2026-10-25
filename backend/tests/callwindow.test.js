import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, line, owner } from "./helpers.js";
import { startFakes } from "./fakes.js";
import { inCallWindow } from "../src/models/Agent.js";

describe("the calling window, unit", () => {
  const w = (over = {}) => ({ enabled: true, start: "09:00", end: "21:00", timezone: "Asia/Kolkata", ...over });
  const ist = (hhmm) => new Date(`2026-10-25T${hhmm}:00+05:30`);

  it("is off by default, so calls always go through", () => {
    expect(inCallWindow({ enabled: false }, ist("03:00"))).toBe(true);
    expect(inCallWindow(undefined, ist("03:00"))).toBe(true);
  });
  it("allows a call inside the window and blocks one outside, in the agent's time zone", () => {
    expect(inCallWindow(w(), ist("10:00"))).toBe(true);
    expect(inCallWindow(w(), ist("08:59"))).toBe(false);
    expect(inCallWindow(w(), ist("21:00"))).toBe(false);
    expect(inCallWindow(w(), ist("20:59"))).toBe(true);
  });
  it("handles a window that runs past midnight", () => {
    const night = w({ start: "22:00", end: "06:00" });
    expect(inCallWindow(night, ist("23:30"))).toBe(true);
    expect(inCallWindow(night, ist("05:00"))).toBe(true);
    expect(inCallWindow(night, ist("12:00"))).toBe(false);
  });
  it("reads the time in the window's own time zone", () => {
    // 21:30 UTC is 03:00 next day in Kolkata (outside) but 22:30 in London (outside 09-21 too).
    const utc = (iso) => new Date(iso);
    expect(inCallWindow(w(), utc("2026-10-25T21:30:00Z"))).toBe(false);
    expect(inCallWindow(w(), utc("2026-10-25T05:30:00Z"))).toBe(true); // 11:00 IST
  });
});

describe("the calling window, saving it", () => {
  beforeEach(freshDb);
  const agent = async () => {
    const b = await owner();
    const a = (await b.post("/api/agents").send({ name: "EMI", prompt: "Hi" })).body;
    return { b, a };
  };

  it("defaults to off and can be switched on with hours and a time zone", async () => {
    const { b, a } = await agent();
    expect(a.settings.call_window).toEqual({ enabled: false, start: "09:00", end: "21:00", timezone: "Asia/Kolkata" });
    const saved = await b.patch(`/api/agents/${a.id}`).send({ settings: { call_window: { enabled: true, start: "10:30", end: "19:00" } } });
    expect(saved.body.settings.call_window).toEqual({ enabled: true, start: "10:30", end: "19:00", timezone: "Asia/Kolkata" });
  });

  it("refuses a bad window in plain words", async () => {
    const { b, a } = await agent();
    for (const [call_window, error] of [
      [{ start: "9am" }, "the calling window's start must be a time like 09:30"],
      [{ end: "25:00" }, "the calling window's end must be a time like 09:30"],
      [{ timezone: "Mars/Olympus" }, "'Mars/Olympus' is not a time zone"],
      [{ start: "09:00", end: "09:00" }, "the calling window must start and end at different times"],
      [{ nope: 1 }, "unknown calling window setting 'nope'"],
    ]) {
      const r = await b.patch(`/api/agents/${a.id}`).send({ settings: { call_window } });
      expect(r.status, error).toBe(400);
      expect(r.body.error).toBe(error);
    }
  });
});

describe("the calling window blocks a call outside it", () => {
  let fakes;
  beforeAll(async () => { fakes = await startFakes(); });
  afterAll(() => fakes.close());
  beforeEach(async () => {
    await freshDb();
    fakes.plivo.requests.length = 0;
    fakes.plivo.reply = { status: 201, body: { request_uuid: "req-0001-abcd" } };
    fakes.voice.reply = { status: 200, body: '<Response><Stream>wss://x/ws</Stream></Response>' };
  });
  afterEach(() => vi.useRealTimers());

  it("returns the popup message and dials no one when now is outside the window", async () => {
    const b = await owner();
    await line(b);
    const a = (await b.post("/api/agents").send({ name: "EMI", prompt: "Hi" })).body;
    await b.patch(`/api/agents/${a.id}`).send({ settings: { call_window: { enabled: true, start: "09:00", end: "21:00", timezone: "Asia/Kolkata" } } });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T01:00:00Z")); // 06:30 IST, before 09:00
    const r = await b.post("/api/calls").send({ to: "9876543210", consent: true, agent_id: a.id });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "This call is getting outside the call window that we had decided for this particular agent.",
      code: "outside_call_window", call_window: { start: "09:00", end: "21:00", timezone: "Asia/Kolkata" } });
    expect(fakes.plivo.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  it("lets the call through inside the window", async () => {
    const b = await owner();
    await line(b);
    const a = (await b.post("/api/agents").send({ name: "EMI", prompt: "Hi" })).body;
    await b.patch(`/api/agents/${a.id}`).send({ settings: { call_window: { enabled: true, start: "00:00", end: "23:59", timezone: "Asia/Kolkata" } } });
    const r = await b.post("/api/calls").send({ to: "9876543210", consent: true, agent_id: a.id });
    expect(r.status).toBe(200);
  });
});
