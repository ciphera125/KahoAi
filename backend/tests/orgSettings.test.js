import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, member, owner, publish } from "./helpers.js";
import { startFakes } from "./fakes.js";
import * as Agent from "../src/models/Agent.js";

let fakes;
beforeAll(async () => { fakes = await startFakes(); });
afterAll(() => fakes.close());
afterEach(() => vi.useRealTimers());
beforeEach(async () => {
  await freshDb();
  fakes.plivo.requests.length = 0;
  fakes.voice.requests.length = 0;
  fakes.plivo.reply = { status: 201, body: { request_uuid: "req-0001-abcd", message: "call fired" } };
  fakes.voice.reply = { status: 200, body: '<Response><Stream bidirectional="true">wss://x/ws</Stream></Response>' };
});

async function setup() {
  const b = await owner();
  const n = (await b.post("/api/numbers").send({ provider: "plivo", number: "+918065520552",
    credentials: { auth_id: "MAID123", auth_token: "plivo-token" } })).body;
  return { b, n };
}
const dials = () => fakes.plivo.requests.filter((q) => q.method === "POST");

describe("the organization's call settings", () => {
  it("start with no cap and no calling hours", async () => {
    const b = await owner();
    const r = await b.get("/api/org/settings");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ max_minutes: null, call_window: { enabled: false } });
  });

  it("are changed by an admin, kept, and shown to everyone", async () => {
    const b = await owner();
    const r = await b.patch("/api/org/settings").send({ max_minutes: 8,
      call_window: { enabled: true, start: "10:00", end: "19:00", timezone: "Asia/Kolkata" } });
    expect(r.status).toBe(200);
    const m = await member(b);
    const seen = (await m.get("/api/org/settings")).body;
    expect(seen.max_minutes).toBe(8);
    expect(seen.call_window).toMatchObject({ enabled: true, start: "10:00", end: "19:00" });
  });

  it("refuse nonsense in plain words", async () => {
    const b = await owner();
    for (const bad of [{ max_minutes: 0 }, { max_minutes: 31 }, { max_minutes: "ten" }, { max_minutes: 2.5 },
      { call_window: { start: "25:00" } }, { call_window: { timezone: "Mars/Base" } }, { call_window: "always" }, { colour: "red" }]) {
      const r = await b.patch("/api/org/settings").send(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.length).toBeGreaterThan(10);
    }
  });

  it("can have the cap taken away again", async () => {
    const b = await owner();
    await b.patch("/api/org/settings").send({ max_minutes: 8 });
    await b.patch("/api/org/settings").send({ max_minutes: null });
    expect((await b.get("/api/org/settings")).body.max_minutes).toBeNull();
  });

  it("are one organization's own", async () => {
    const b = await owner();
    await b.patch("/api/org/settings").send({ max_minutes: 8 });
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect((await other.get("/api/org/settings")).body.max_minutes).toBeNull();
  });
});

describe("and they hold on every call", () => {
  it("cap how long any agent's call can be, whatever the agent says", async () => {
    const b = await owner();
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "Hi" })).body;
    await b.patch(`/api/agents/${a.id}`).send({ settings: { max_minutes: 9 } });
    await publish(b, a.id);
    expect((await Agent.callConfig(a.id)).max_secs).toBe(540);
    await b.patch("/api/org/settings").send({ max_minutes: 5 });
    expect((await Agent.callConfig(a.id)).max_secs).toBe(300);
  });

  it("refuse a call outside the organization's calling hours, and dial no one", async () => {
    const { b, n } = await setup();
    await b.patch("/api/org/settings").send({ call_window: { enabled: true, start: "09:00", end: "21:00", timezone: "Asia/Kolkata" } });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T01:00:00Z")); // 06:30 in India
    const r = await b.post("/api/calls").send({ from_id: n.id, to: "9876543210", consent: true });
    vi.useRealTimers();
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("outside_call_window");
    expect(r.body.error).toMatch(/organization/i);
    expect(dials()).toHaveLength(0);
  });

  it("let a call through inside the hours", async () => {
    const { b, n } = await setup();
    await b.patch("/api/org/settings").send({ call_window: { enabled: true, start: "00:00", end: "23:59", timezone: "Asia/Kolkata" } });
    const r = await b.post("/api/calls").send({ from_id: n.id, to: "9876543210", consent: true });
    expect(r.status).toBe(200);
    expect(dials()).toHaveLength(1);
  });
});
