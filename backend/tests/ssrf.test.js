import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app, freshDb, owner } from "./helpers.js";
import { startFakes } from "./fakes.js";
import { config } from "../src/config/env.js";
import { callOut, isPrivateAddress, urlProblem } from "../src/models/outbound.js";

let was;
beforeEach(() => { was = config.NODE_ENV; });
afterEach(() => { config.NODE_ENV = was; });

const LOOPBACKS = [
  "https://127.0.0.1/x", "https://127.0.0.1:8021/internal/v1/x", "https://localhost/x", "https://localhost:8021/x",
  "https://LOCALHOST/x", "https://localhost./x", "https://api.localhost/x", "https://[::1]/x", "https://127.1/x",
  "https://2130706433/x", "https://0x7f.1/x", "https://0177.0.0.1/x", "https://127.255.255.254/x",
  "https://[::ffff:127.0.0.1]/x", "https://[::ffff:7f00:1]/x", "https://[::127.0.0.1]/x", "https://[::7f00:1]/x",
  "https://[64:ff9b::7f00:1]/x", "https://[2002:7f00:1::]/x", "https://0.0.0.0/x", "https://[::]/x",
  "https://[::ffff:10.0.0.1]/x", "https://[::ffff:a00:1]/x", "https://[::ffff:169.254.169.254]/x", "https://[::ffff:a9fe:a9fe]/x",
  "https://[64:ff9b::a9fe:a9fe]/x", "https://metadata.google.internal/x",
];

describe("in production, nothing on this machine or its network can be called", () => {
  it.each(LOOPBACKS)("refuses %s", (u) => {
    config.NODE_ENV = "production";
    expect(urlProblem(u), u).toBeTruthy();
  });

  it("still lets a normal public address through", () => {
    config.NODE_ENV = "production";
    for (const u of ["https://api.example.com/x", "https://203.0.113.9/x", "https://[2606:4700::1111]/x"]) expect(urlProblem(u), u).toBeNull();
  });

  it("recognises private addresses written every way", () => {
    for (const a of ["::ffff:7f00:1", "::ffff:a00:1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["::ffff:8.8.8.8", "::ffff:808:808", "2606:4700::1111", "8.8.8.8"]) expect(isPrivateAddress(a), a).toBe(false);
  });

  it("never even tries to connect to one", async () => {
    config.NODE_ENV = "production";
    const out = await callOut({ url: "https://127.0.0.1:1/x", timeoutMs: 500 });
    expect(out.ok).toBe(false);
    expect(out.problem).toMatch(/private network|cannot call/i);
  });

  it("is refused when a tool or the webhook is saved", async () => {
    config.NODE_ENV = "production";
    await freshDb();
    const b = await owner();
    for (const u of ["https://127.0.0.1/x", "https://[::ffff:7f00:1]/x", "https://localhost/x"]) {
      expect((await b.patch("/api/org/settings").send({ webhook_url: u })).status, u).toBe(400);
      expect((await b.post("/api/custom-tools").send({ label: "T", description: "d", url: u, inputs: [] })).status, u).toBe(400);
    }
  });

  it("keeps localhost working while developing, so the Studio can be tried on this machine", () => {
    config.NODE_ENV = "development";
    expect(urlProblem("http://127.0.0.1:9000/x")).toBeNull();
    expect(urlProblem("http://localhost:9000/x")).toBeNull();
    expect(urlProblem("https://169.254.169.254/x")).toBeTruthy();
  });
});

describe("placing calls through the API is limited", () => {
  let fakes;
  beforeAll(async () => { fakes = await startFakes(); });
  afterAll(() => fakes.close());
  beforeEach(async () => {
    await freshDb();
    fakes.plivo.requests.length = 0;
    fakes.plivo.reply = () => ({ status: 201, body: { request_uuid: `req-${Math.random().toString(16).slice(2, 10)}-rl`, message: "ok" } });
    fakes.voice.reply = { status: 200, body: '<Response><Stream bidirectional="true">wss://x/ws</Stream></Response>' };
  });
  const setup = async (email = "asha@acme.in", organization = "Acme", number = "+918065520552") => {
    const b = await owner({ email, organization });
    await b.post("/api/numbers").send({ provider: "plivo", number, credentials: { auth_id: "MAID123", auth_token: "t" } });
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    const key = (await b.post("/api/api-keys").send({ name: "CRM" })).body.key;
    const place = (k, i) => request(app).post("/api/v1/calls").set("Authorization", `Bearer ${k}`)
      .send({ to: `+9198765${String(10000 + i)}`, agent_id: a.id, consent: true });
    return { b, a, key, place };
  };
  const dials = () => fakes.plivo.requests.filter((q) => q.method === "POST").length;

  it("stops a burst at the per-minute limit, and says so plainly", async () => {
    const { key, place } = await setup();
    const codes = [];
    for (let i = 0; i < config.API_CALLS_PER_MIN + 5; i++) codes.push((await place(key, i)).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(config.API_CALLS_PER_MIN);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
    expect(dials()).toBe(config.API_CALLS_PER_MIN);
    const refused = await place(key, 99);
    expect(refused.body.error).toMatch(/too many calls/i);
  });

  it("counts the whole organization, so more keys do not buy more calls", async () => {
    const { b, key, place } = await setup();
    const second = (await b.post("/api/api-keys").send({ name: "Second" })).body.key;
    for (let i = 0; i < config.API_CALLS_PER_MIN; i++) await place(key, i);
    expect((await place(second, 50)).status).toBe(429);
  });

  it("does not let one organization use up another's allowance", async () => {
    const one = await setup();
    const two = await setup("zoya@other.in", "Other", "+918065520999");
    for (let i = 0; i < config.API_CALLS_PER_MIN; i++) await one.place(one.key, i);
    expect((await one.place(one.key, 60)).status).toBe(429);
    expect((await two.place(two.key, 0)).status).toBe(200);
  });

  it("does not slow reading calls or agents", async () => {
    const { key, place } = await setup();
    for (let i = 0; i < config.API_CALLS_PER_MIN + 2; i++) await place(key, i);
    expect((await request(app).get("/api/v1/agents").set("Authorization", `Bearer ${key}`)).status).toBe(200);
    expect((await request(app).get("/api/v1/calls").set("Authorization", `Bearer ${key}`)).status).toBe(200);
  });

  it("has a daily ceiling as well", () => {
    expect(config.API_CALLS_PER_DAY).toBeGreaterThan(config.API_CALLS_PER_MIN);
    expect(config.API_CALLS_PER_DAY).toBeLessThanOrEqual(2000);
  });
});
