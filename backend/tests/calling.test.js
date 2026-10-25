import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb, owner, db } from "./helpers.js";
import { startFakes } from "./fakes.js";
import { sign } from "../src/services/plivoSignature.js";

let fakes;
beforeAll(async () => { fakes = await startFakes(); });
afterAll(() => fakes.close());
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

describe("Plivo signatures", () => {
  it("match the Python implementation byte for byte", () => {
    expect(sign("GET", "https://voice.example.test/answer?token=hook%20secret&agent=default&peer=%2B919876543210&max=600&studio_agent=ag_0123456789ab",
      {}, "abc123nonce", "plivo-token")).toBe("uIWdAowCVfxTbbsVQFO0xsG1O2V15JOhqKGt2fhfZsg=");
    expect(sign("POST", "https://voice.example.test/hangup?token=x&peer=%2B91",
      { CallUUID: ["u-1"], CallStatus: ["completed"] }, "n2", "tok")).toBe("/CpSWjOgjU709nxS8+Xo9qxsVcLp8d5NvCb8gAm6/1o=");
  });
});

describe("placing a call", () => {
  it("checks the voice server, then dials Plivo once with this number's credentials", async () => {
    const { b, n } = await setup();
    const r = await b.post("/api/calls").send({ from_id: n.id, to: "98765 43210", consent: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ to: "+919876543210", from: "+918065520552", request_uuid: "req-0001-abcd", agent_name: null });
    expect(fakes.voice.requests).toHaveLength(1);
    expect(fakes.voice.requests[0].headers["x-plivo-signature-v3"]).toBeTruthy();
    const dials = fakes.plivo.requests.filter((q) => q.method === "POST");
    expect(dials).toHaveLength(1);
    expect(dials[0].url).toBe("/v1/Account/MAID123/Call/");
    expect(dials[0].headers.authorization).toBe(`Basic ${Buffer.from("MAID123:plivo-token").toString("base64")}`);
    expect(dials[0].body).toMatchObject({ from: "+918065520552", to: "+919876543210", answer_method: "POST",
      time_limit: 615, ring_timeout: 45, hangup_method: "POST" });
    expect(dials[0].body.answer_url).toContain("token=hook-secret");
    const { rows } = await db.query("SELECT status, peer, ours, direction FROM calls WHERE call_id = 'req-0001-abcd'");
    expect(rows[0]).toEqual({ status: "ringing", peer: "+919876543210", ours: "+918065520552", direction: "outbound" });
  });

  it("carries an agent's limits and id", async () => {
    const { b, n } = await setup();
    const a = (await b.post("/api/agents").send({ name: "EMI", prompt: "Hi" })).body;
    await b.patch(`/api/agents/${a.id}`).send({ settings: { max_minutes: 2, ring_secs: 20 } });
    const r = await b.post("/api/calls").send({ from_id: n.id, to: "9876543210", consent: true, agent_id: a.id });
    expect(r.body.agent_name).toBe("EMI");
    const dial = fakes.plivo.requests.find((q) => q.method === "POST");
    expect(dial.body).toMatchObject({ time_limit: 135, ring_timeout: 20 });
    expect(dial.body.answer_url).toContain(`studio_agent=${a.id}`);
    expect(dial.body.hangup_url).toContain(`studio_agent=${a.id}`);
    expect((await b.post("/api/calls").send({ from_id: n.id, to: "9876543210", consent: true, agent_id: "ag_000000000000" })).body.error)
      .toBe("choose an agent that exists");
  });

  it("dials no one without consent, from a bad number, or to a Do not call contact", async () => {
    const { b, n } = await setup();
    expect((await b.post("/api/calls").send({ from_id: n.id, to: "9876543210" })).body.error)
      .toBe("confirm that this person has agreed to be called");
    expect((await b.post("/api/calls").send({ from_id: "nope", to: "9876543210", consent: true })).body.error)
      .toBe("choose a number to call from");
    expect((await b.post("/api/calls").send({ from_id: n.id, to: "12", consent: true })).status).toBe(400);
    const c = (await b.post("/api/contacts").send({ name: "Asha", numbers: ["9876543210"] })).body;
    await b.patch(`/api/contacts/${c.id}`).send({ dnc: true });
    expect((await b.post("/api/calls").send({ from_id: n.id, to: "+919876543210", consent: true })).body.error)
      .toBe("+919876543210 is marked Do not call in Contacts");
    const ex = (await b.post("/api/numbers").send({ provider: "exotel", number: "9000000000",
      credentials: { account_sid: "a", api_key: "b", api_token: "c", subdomain: "d" } })).body;
    expect((await b.post("/api/calls").send({ from_id: ex.id, to: "9876543211", consent: true })).body.error)
      .toBe("Exotel numbers are not connected yet; only Plivo can place calls today");
    expect(fakes.plivo.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  it("dials no one when the voice server is not answering properly", async () => {
    const { b, n } = await setup();
    fakes.voice.reply = { status: 403, body: "no" };
    const r = await b.post("/api/calls").send({ from_id: n.id, to: "9876543210", consent: true });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/WEBHOOK_SECRET.*Nothing was dialled/);
    expect(fakes.plivo.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  it("reports a failed dial and never retries it", async () => {
    const { b, n } = await setup();
    fakes.plivo.reply = { status: 500, body: { error: "boom" } };
    const r = await b.post("/api/calls").send({ from_id: n.id, to: "9876543210", consent: true });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/MAY OR MAY NOT have been placed/);
    expect(fakes.plivo.requests.filter((q) => q.method === "POST")).toHaveLength(1);
    fakes.plivo.reply = { status: 401, body: {} };
    const auth = await b.post("/api/calls").send({ from_id: n.id, to: "9876543210", consent: true });
    expect(auth.body.error).toBe("Plivo rejected the Auth ID / Auth token. Nothing was dialled.");
  });

  it("gives up on a Plivo that never answers, within its deadline", async () => {
    const { b, n } = await setup();
    fakes.plivo.reply = { hang: true };
    const started = Date.now();
    const r = await b.post("/api/calls").send({ from_id: n.id, to: "9876543210", consent: true });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/MAY OR MAY NOT/);
    expect(Date.now() - started).toBeLessThan(14000);
  }, 20000);
});

describe("syncing outcomes from Plivo", () => {
  it("copies how recent calls ended (owner only)", async () => {
    const { b } = await setup();
    fakes.plivo.cdrs = [{ call_uuid: "cdr-0001-xyz", call_direction: "outbound", from_number: "918065520552",
      to_number: "919876543210", call_state: "completed", hangup_cause_name: "Normal Hangup", bill_duration: 42,
      total_amount: "0.84", initiation_time: "2026-10-20 10:00:00+05:30" }];
    const r = await b.post("/api/dashboard/sync");
    expect(r.body).toEqual({ synced: 1 });
    const { rows } = await db.query("SELECT status, peer, duration_secs, cost FROM calls WHERE call_id = 'cdr-0001-xyz'");
    expect(rows[0]).toEqual({ status: "answered", peer: "+919876543210", duration_secs: 42, cost: 0.84 });
  });
});
