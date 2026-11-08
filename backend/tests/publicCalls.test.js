import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app, freshDb, internal, owner } from "./helpers.js";
import { startFakes } from "./fakes.js";

let fakes;
beforeAll(async () => { fakes = await startFakes(); });
afterAll(() => fakes.close());
beforeEach(async () => {
  await freshDb();
  fakes.plivo.requests.length = 0;
  fakes.plivo.reply = { status: 201, body: { request_uuid: "req-0001-abcd", message: "call fired" } };
  fakes.voice.reply = { status: 200, body: '<Response><Stream bidirectional="true">wss://x/ws</Stream></Response>' };
});

async function setup() {
  const b = await owner();
  const n = (await b.post("/api/numbers").send({ provider: "plivo", number: "+918065520552",
    credentials: { auth_id: "MAID123", auth_token: "plivo-token" } })).body;
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  const key = (await b.post("/api/api-keys").send({ name: "CRM" })).body.key;
  const api = (method, path) => request(app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${key}`);
  return { b, n, a, api };
}

describe("the public API: agents and calls", () => {
  it("lists the agents a system can call with", async () => {
    const { a, api } = await setup();
    const r = await api("get", "/agents");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([expect.objectContaining({ id: a.id, name: "Ria" })]);
    expect(r.body[0].prompt).toBeUndefined();
  });

  it("places a call, only with the person's agreement stated", async () => {
    const { a, api } = await setup();
    const no = await api("post", "/calls").send({ to: "+919876543210", agent_id: a.id });
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/agreed to be called/);
    expect(fakes.plivo.requests.filter((q) => q.method === "POST")).toHaveLength(0);
    const ok = await api("post", "/calls").send({ to: "+919876543210", agent_id: a.id, consent: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ to: "+919876543210", request_uuid: "req-0001-abcd" });
    expect(fakes.plivo.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("refuses a Do not call number and an agent from another organization", async () => {
    const { b, a, api } = await setup();
    const meena = (await b.post("/api/contacts").send({ name: "Meena", numbers: ["+919811111111"] })).body;
    await b.patch(`/api/contacts/${meena.id}`).send({ dnc: true });
    const dnc = await api("post", "/calls").send({ to: "+919811111111", agent_id: a.id, consent: true });
    expect(dnc.status).toBe(400);
    expect(dnc.body.error).toMatch(/Do not call/);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    const theirs = (await other.post("/api/agents").send({ name: "Theirs", prompt: "You are theirs." })).body;
    const r = await api("post", "/calls").send({ to: "+919876543210", agent_id: theirs.id, consent: true });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(fakes.plivo.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  it("fetches a finished call with its summary, answers and transcript", async () => {
    const { a, api } = await setup();
    await internal("put", "/internal/v1/calls/pub-call-1").send({ agent_id: a.id, direction: "outbound", status: "answered", peer: "+919876543210" });
    await internal("post", "/internal/v1/calls/pub-call-1/events").send({ events: [
      { event: "call_start", at: Date.now() / 1000 }, { event: "turn", role: "caller", text: "I will pay on Friday", at: Date.now() / 1000 + 1 },
      { event: "summary", summary: "Will pay Friday.", at: Date.now() / 1000 + 5 }] });
    const r = await api("get", "/calls/pub-call-1");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ call_id: "pub-call-1", agent_id: a.id, summary: "Will pay Friday.", answers: [] });
    expect(r.body.transcript.some((t) => /pay on Friday/.test(t.text))).toBe(true);
    const list = await api("get", "/calls?per_page=10");
    expect(list.body.calls.map((c) => c.call_id)).toContain("pub-call-1");
  });

  it("never shows another organization's call", async () => {
    const { a, api } = await setup();
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    const theirs = (await other.post("/api/agents").send({ name: "Theirs", prompt: "You are theirs." })).body;
    await internal("put", "/internal/v1/calls/pub-call-2").send({ agent_id: theirs.id, status: "answered" });
    expect((await api("get", "/calls/pub-call-2")).status).toBe(404);
    expect((await api("get", "/calls")).body.calls.map((c) => c.call_id)).not.toContain("pub-call-2");
    expect(a.id).toBeTruthy();
  });

  it("needs a key", async () => {
    await setup();
    for (const [m, p] of [["get", "/agents"], ["post", "/calls"], ["get", "/calls"], ["get", "/calls/x"]]) {
      expect((await request(app)[m](`/api/v1${p}`)).status, p).toBe(401);
    }
  });
});
