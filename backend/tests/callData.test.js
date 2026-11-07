import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { db, freshDb, internal, line, owner, OURS } from "./helpers.js";

const events = (id, list) => internal("post", `/internal/v1/calls/${id}/events`).send({ events: list });
const T = "2026-11-05T10:00:00.000Z";
const batch = () => [
  { event: "call_start", at: T },
  { event: "call_party", number: "+919876543210", direction: "inbound", at: T },
  { event: "turn", role: "assistant", text: "Namaste, KahoAI here.", at: "2026-11-05T10:00:01.000Z" },
  { event: "turn", role: "user", text: "I want a loan quote", at: "2026-11-05T10:00:05.000Z" },
  { event: "tool", name: "capture_lead", ok: true, text: "{}", at: "2026-11-05T10:00:06.000Z" },
  { event: "call_end", at: "2026-11-05T10:01:00.000Z" },
];
const rows = (id) => db.query("SELECT event, role, text FROM call_events WHERE call_id = $1 ORDER BY id", [id]);

let fake, fakeLog;
beforeAll(async () => {
  fakeLog = [];
  fake = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      fakeLog.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.url.endsWith("/missing.opus")) { res.writeHead(404); return res.end('{"error":"Object not found"}'); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ signedURL: `/object/sign/${req.url.split("/sign/")[1]}?token=tok123` }));
    });
  });
  await new Promise((r) => fake.listen(18767, "127.0.0.1", r));
});
afterAll(() => new Promise((r) => fake.close(r)));
beforeEach(async () => { await freshDb(); fakeLog.length = 0; });

describe("a refused tool call is kept, so the cause is visible afterwards", () => {
  it("stores the tool the model tried to call", async () => {
    // 2026-11-07, call db32d982: Groq refused the turn and nothing recorded which tool
    // the model reached for, so the cause had to be guessed from the prompt.
    await events("call-rejected-1", [{ event: "tool_rejected", tool: "get_tasks",
      reason: "Tool call validation failed", at: T }]);
    const { rows } = await db.query("SELECT event, name FROM call_events WHERE call_id = $1", ["call-rejected-1"]);
    expect(rows).toEqual([{ event: "tool_rejected", name: "get_tasks" }]);
  });

  it("stores one even when the error named no tool", async () => {
    await events("call-rejected-2", [{ event: "tool_rejected", tool: "unknown", reason: "x", at: T }]);
    const { rows } = await db.query("SELECT name FROM call_events WHERE call_id = $1", ["call-rejected-2"]);
    expect(rows).toEqual([{ name: "unknown" }]);
  });
});

describe("transcript writes are idempotent", () => {
  it("the same batch twice leaves identical lines and counters", async () => {
    await events("call-idem-1", batch());
    const first = (await rows("call-idem-1")).rows;
    await events("call-idem-1", batch());
    expect((await rows("call-idem-1")).rows).toEqual(first);
    const c = (await db.query("SELECT turns, caller_turns, lead FROM calls WHERE call_id = 'call-idem-1'")).rows[0];
    expect(c).toEqual({ turns: 2, caller_turns: 1, lead: true });
  });
  it("a sentence repeated at a different time is a different line", async () => {
    await events("call-idem-2", [{ event: "turn", role: "user", text: "hello", at: T }, { event: "turn", role: "user", text: "hello", at: "2026-11-05T10:00:09.000Z" }]);
    expect((await rows("call-idem-2")).rowCount).toBe(2);
    expect((await db.query("SELECT turns FROM calls WHERE call_id = 'call-idem-2'")).rows[0].turns).toBe(2);
  });
});

describe("finding calls by what was said", () => {
  it("matches the summary or any line, in the organization's own calls only", async () => {
    const a = await owner(); await line(a);
    const b = await owner({ email: "bob@other.in", organization: "Other" });
    await internal("put", "/internal/v1/calls/call-find-1").send({ ours: OURS });
    await events("call-find-1", [...batch(), { event: "summary", summary: "Asked about a home loan quote" }]);
    const hit = await a.get("/api/calls?q=loan");
    expect(hit.status).toBe(200);
    expect(hit.body.calls.map((c) => c.call_id)).toEqual(["call-find-1"]);
    expect(hit.body).toHaveProperty("total", 1);
    expect((await a.get("/api/calls?q=" + encodeURIComponent("home quote"))).body.total).toBe(1);
    expect((await a.get("/api/calls?q=zebra")).body.total).toBe(0);
    expect((await b.get("/api/calls?q=loan")).body.total).toBe(0);
  });
  it.each(["' OR 1=1 --", "'; DROP TABLE calls;--", "\"unterminated", "a & | ! ( ) :*", "x".repeat(5000)])("hostile q %s is harmless", async (q) => {
    const a = await owner();
    const r = await a.get("/api/calls?q=" + encodeURIComponent(q));
    expect([200, 400]).toContain(r.status);
    expect((await db.query("SELECT count(*)::int n FROM calls")).rows[0].n).toBe(0);
  });
});

describe("recordings are linked to calls", () => {
  const path = (id) => `2026/11/${id}.opus`;
  const report = (id, body) => internal("post", `/internal/v1/calls/${id}/recording`).send(body);

  it("the voice service reports one, the Studio gets a short-lived signed link", async () => {
    const a = await owner(); await line(a);
    await internal("put", "/internal/v1/calls/call-rec-1").send({ ours: OURS });
    expect((await report("call-rec-1", { path: path("call-rec-1"), bytes: 4096, mime: "audio/opus" })).status).toBe(200);
    const list = await a.get("/api/calls");
    expect(list.body.calls[0]).toMatchObject({ call_id: "call-rec-1", has_recording: true });
    const r = await a.get("/api/calls/call-rec-1/recording");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      url: `${config.SUPABASE_URL}/storage/v1/object/sign/call-recordings/2026/11/call-rec-1.opus?token=tok123`,
      download_url: `${config.SUPABASE_URL}/storage/v1/object/sign/call-recordings/2026/11/call-rec-1.opus?token=tok123&download=call-rec-1.opus`,
      expires_in: 600, mime: "audio/opus", bytes: 4096,
    });
    expect(fakeLog[0]).toMatchObject({ auth: `Bearer ${config.SUPABASE_SECRET_KEY}` });
    expect(JSON.parse(fakeLog[0].body)).toEqual({ expiresIn: 600 });
  });
  it("another organization, an unknown call, or a call without audio all get 404", async () => {
    const a = await owner(); await line(a);
    const b = await owner({ email: "bob@other.in", organization: "Other" });
    await internal("put", "/internal/v1/calls/call-rec-2").send({ ours: OURS });
    await internal("put", "/internal/v1/calls/call-rec-3").send({ ours: OURS });
    await report("call-rec-2", { path: path("call-rec-2"), bytes: 10, mime: "audio/opus" });
    expect((await b.get("/api/calls/call-rec-2/recording")).status).toBe(404);
    expect((await a.get("/api/calls/nope-nope-1/recording")).status).toBe(404);
    expect((await a.get("/api/calls/call-rec-3/recording")).status).toBe(404);
    expect((await a.get("/api/calls/..%2F..%2Fetc/recording")).status).toBe(404);
    expect(fakeLog.length).toBe(0);
  });
  it.each([
    [{ path: "2026/11/other-call.opus", bytes: 10, mime: "audio/opus" }],
    [{ path: "../../etc/passwd", bytes: 10, mime: "audio/opus" }],
    [{ path: "2026/11/call-rec-4.opus", bytes: 10, mime: "text/html" }],
    [{ path: "2026/11/call-rec-4.opus", bytes: 0, mime: "audio/opus" }],
    [{ path: "2026/11/call-rec-4.opus", bytes: 300 * 1024 * 1024, mime: "audio/opus" }],
    [{ path: "2026/11/call-rec-4.opus", bytes: 1.5, mime: "audio/opus" }],
    [{ path: "2026/11/call-rec-4.exe", bytes: 10, mime: "audio/opus" }],
  ])("a bad report %j is refused", async (body) => {
    expect((await report("call-rec-4", body)).status).toBe(400);
    expect((await db.query("SELECT recording_path FROM calls WHERE call_id = 'call-rec-4'")).rows[0]?.recording_path ?? null).toBeNull();
  });
  it("the report needs the service token", async () => {
    const supertest = (await import("supertest")).default;
    const { internalApp } = await import("./helpers.js");
    const r = await supertest(internalApp).post("/internal/v1/calls/call-rec-5/recording").send({ path: path("call-rec-5"), bytes: 1, mime: "audio/opus" });
    expect(r.status).toBe(401);
  });
  it("without Supabase settings the route says so, and a Storage failure never leaks the key", async () => {
    const a = await owner(); await line(a);
    await internal("put", "/internal/v1/calls/call-rec-6").send({ ours: OURS });
    await report("call-rec-6", { path: "2026/11/call-rec-6.opus", bytes: 10, mime: "audio/opus" });
    await db.query("UPDATE calls SET recording_path = '2026/11/missing.opus' WHERE call_id = 'call-rec-6'");
    const missing = await a.get("/api/calls/call-rec-6/recording");
    expect(missing.status).toBe(502);
    expect(JSON.stringify(missing.body)).not.toContain(config.SUPABASE_SECRET_KEY);
    const saved = config.SUPABASE_URL;
    config.SUPABASE_URL = "";
    try {
      const r = await a.get("/api/calls/call-rec-6/recording");
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("recordings are not configured");
    } finally { config.SUPABASE_URL = saved; }
  });
});
