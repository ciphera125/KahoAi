import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { app, freshDb, internal, ORIGIN, owner, db, line, OURS } from "./helpers.js";
import { maskSensitive } from "../src/utils/masking.js";

beforeEach(freshDb);

const events = (id, list) => internal("post", `/internal/v1/calls/${id}/events`).send({ events: list });
const at = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();

async function talkedCall(id, { peer = "+919876543210", minsAgo = 5, callerTurns = 2, agentId } = {}) {
  await internal("put", `/internal/v1/calls/${id}`).send({ ours: OURS, ...(agentId ? { agent_id: agentId, status: "answered" } : {}) });
  const list = [{ event: "call_start", at: at(minsAgo) }, { event: "call_party", number: peer, direction: "outbound", at: at(minsAgo) },
    { event: "turn", role: "assistant", text: "Hello, this is Aayushi.", at: at(minsAgo) }];
  for (let i = 0; i < callerTurns; i++) list.push({ event: "turn", role: "user", text: `reply ${i}`, at: at(minsAgo) });
  list.push({ event: "call_end", at: at(minsAgo - 1) });
  const r = await events(id, list);
  expect(r.status).toBe(200);
}

describe("masking, the same rules as masking.py", () => {
  it.each([
    ["My aadhaar is 2345 6789 0123 ok", "My aadhaar is XXXX XXXX 0123 ok"],
    ["pan abcde1234f", "pan XXXXXX234F"],
    ["A B C D E 1 2 3 4 F", "XXXXXX234F"],
    ["card 1234567812345678", "card 1234567812345678"],
    ["call +91 98765 43210", "call +91 98765 43210"],
    ["२३४५६७८९०१२३", "XXXX XXXX 0123"],
    ["91 98765 43210", "XXXX XXXX 3210"],
    ["id 2345-6789-0123.", "id XXXX XXXX 0123."],
  ])("%s", (input, expected) => expect(maskSensitive(input)).toBe(expected));
});

describe("what the voice service reports (internal API)", () => {
  it("builds the call from its transcript lines: who, when, turns, a lead, the summary", async () => {
    await events("call-0001", [
      { event: "call_start", at: "2026-10-23T22:01:32Z" },
      { event: "call_party", number: "09876543210", direction: "inbound" },
      { event: "turn", role: "assistant", text: "Hello" },
      { event: "turn", role: "user", text: "Hi" },
      { event: "tool", name: "capture_lead", text: JSON.stringify({ args: { name: "Asha" }, result: { status: "saved" } }) },
      { event: "call_end", at: "2026-10-23T22:03:02Z" },
      { event: "summary", summary: "Asha asked about EMIs." },
    ]);
    const { rows: [c] } = await db.query("SELECT * FROM calls WHERE call_id = 'call-0001'");
    expect(c).toMatchObject({ peer: "+919876543210", direction: "inbound", turns: 2, caller_turns: 1, lead: true,
      duration_secs: 90, has_transcript: true, summary: "Asha asked about EMIs." });
  });

  it("does not count a lead whose save failed", async () => {
    await events("call-0002", [{ event: "call_start" },
      { event: "tool", name: "capture_lead", text: JSON.stringify({ args: {}, result: { error: "empty" } }) }]);
    expect((await db.query("SELECT lead FROM calls")).rows[0].lead).toBe(false);
  });

  it("masks ID numbers in turns and summaries, blanks digits in live captions, keeps no tool arguments", async () => {
    await events("call-0003", [{ event: "call_start" },
      { event: "turn", role: "user", text: "my aadhaar 2345 6789 0123" },
      { event: "live", role: "caller", text: "2345 67" },
      { event: "tool", name: "capture_lead", text: JSON.stringify({ args: { phone: "9876543210" }, result: { status: "saved" } }) },
      { event: "summary", summary: "PAN ABCDE1234F given" }]);
    const { rows } = await db.query("SELECT event, text, name FROM call_events ORDER BY id");
    const all = JSON.stringify(rows) + JSON.stringify((await db.query("SELECT summary FROM calls")).rows);
    expect(all).not.toMatch(/2345 6789|ABCDE1234F|9876543210/);
    expect(rows.find((r) => r.event === "turn").text).toBe("my aadhaar XXXX XXXX 0123");
    expect(rows.find((r) => r.event === "live").text).toBe("•••• ••");
    expect(rows.find((r) => r.event === "tool")).toEqual({ event: "tool", text: null, name: "capture_lead" });
  });

  it("refuses a bad call id, a non-list, and an oversized batch", async () => {
    expect((await events("../etc", [])).status).toBe(404);
    expect((await events("bad!id", [])).status).toBe(400);
    expect((await internal("post", "/internal/v1/calls/call-0004/events").send({ events: "x" })).status).toBe(400);
    expect((await events("call-0004", Array.from({ length: 501 }, () => ({ event: "turn", role: "user", text: "x" })))).status).toBe(400);
  });
});

describe("calls in the Studio", () => {
  it("lists calls newest first, a page at a time, with agent and contact names", async () => {
    const b = await owner();
    await line(b);
    const a = (await b.post("/api/agents").send({ name: "EMI", prompt: "Hi" })).body;
    await b.post("/api/contacts").send({ name: "Asha", numbers: ["9876543210"] });
    for (let i = 0; i < 12; i++) await talkedCall(`call-${String(i).padStart(4, "0")}`, { minsAgo: 100 - i, agentId: i === 11 ? a.id : undefined });
    const p1 = (await b.get("/api/calls?page=1&per_page=10")).body;
    expect(p1).toMatchObject({ total: 12, page: 1, per_page: 10 });
    expect(p1.calls[0]).toMatchObject({ call_id: "call-0011", agent_name: "EMI", contact_name: "Asha", status: "answered",
      successful: true, has_transcript: true, turns: 3, caller_turns: 2 });
    expect((await b.get("/api/calls?page=2&per_page=10")).body.calls).toHaveLength(2);
    expect((await b.get("/api/calls?per_page=7")).body.error).toBe("per_page must be one of 10, 20, 25, 50");
  });

  it("shows a call ringing for over 15 minutes as unknown, and a short call as not successful", async () => {
    const b = await owner();
    await line(b);
    await internal("put", "/internal/v1/calls/call-ring").send({ ours: OURS, status: "ringing", at: at(20) });
    await talkedCall("call-short", { callerTurns: 1 });
    const calls = (await b.get("/api/calls")).body.calls;
    expect(calls.find((c) => c.call_id === "call-ring").status).toBe("unknown");
    expect(calls.find((c) => c.call_id === "call-short").successful).toBe(false);
  });

  it("gives a call's transcript, and a CSV a spreadsheet cannot run", async () => {
    const b = await owner();
    await line(b);
    await internal("put", "/internal/v1/calls/call-0005").send({ ours: OURS });
    await events("call-0005", [{ event: "call_start" }, { event: "turn", role: "assistant", text: "Hello", at: "2026-10-23T22:01:40Z" },
      { event: "turn", role: "user", text: "=HYPERLINK(\"http://evil\",\"x\"), \"quoted\"" }]);
    const t = (await b.get("/api/calls/call-0005/transcript")).body;
    expect(t).toEqual([{ at: "2026-10-23T22:01:40.000Z", role: "agent", text: "Hello" },
      { at: expect.any(String), role: "caller", text: "=HYPERLINK(\"http://evil\",\"x\"), \"quoted\"" }]);
    const csv = await b.get("/api/calls/call-0005/transcript.csv");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="call-call-0005.csv"');
    expect(csv.text.split("\r\n")[0]).toBe("time,speaker,text");
    expect(csv.text).toContain(`Caller,"'=HYPERLINK(""http://evil"",""x""), ""quoted"""`);
    expect((await b.get("/api/calls/nope!/transcript")).status).toBe(404);
    expect((await b.get("/api/calls/call-none/transcript")).status).toBe(404);
  });

  it("pages a contact's calls", async () => {
    const b = await owner();
    await line(b);
    const c = (await b.post("/api/contacts").send({ name: "Asha", numbers: ["9876543210"] })).body;
    await talkedCall("call-a001");
    await talkedCall("call-b001", { peer: "+919000000000" });
    const r = (await b.get(`/api/contacts/${c.id}/calls?page=1&per_page=10`)).body;
    expect(r.total).toBe(1);
    expect(r.calls[0].call_id).toBe("call-a001");
    expect((await b.get("/api/contacts/nope/calls")).status).toBe(404);
  });
});

describe("the live transcript", () => {
  let server, port;
  beforeAll(async () => { server = http.createServer(app); await new Promise((r) => server.listen(0, "127.0.0.1", r)); port = server.address().port; });
  afterAll(() => new Promise((r) => server.close(r)));

  function stream(cookie, id) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: `/api/calls/${id}/stream`,
        headers: { Cookie: cookie, Origin: ORIGIN, Host: "localhost:8020" } }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"],
          events: data.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))) }));
      });
      req.on("error", reject);
      req.setTimeout(10000, () => { req.destroy(new Error("stream did not end")); });
    });
  }
  const cookieOf = async (b) => (await b.post("/api/auth/login").send({ email: "asha@acme.in", password: "correct horse" }))
    .headers["set-cookie"].find((c) => c.startsWith("kaho_session=")).split(";")[0];

  const ownerWithCall = async (id) => {
    const b = await owner();
    await line(b);
    await internal("put", `/internal/v1/calls/${id}`).send({ ours: OURS, status: "ringing", at: new Date().toISOString() });
    return cookieOf(b);
  };

  it("streams the call as it is written, until it ends", async () => {
    const cookie = await ownerWithCall("call-live1");
    const pending = stream(cookie, "call-live1");
    await new Promise((r) => setTimeout(r, 300));
    await events("call-live1", [{ event: "call_start" }, { event: "live", role: "caller", text: "Hel" }]);
    await new Promise((r) => setTimeout(r, 300));
    await events("call-live1", [{ event: "turn", role: "user", text: "Hello" }, { event: "turn", role: "assistant", text: "Hi!" },
      { event: "tool", name: "end_call" }, { event: "call_end" }]);
    const r = await pending;
    expect(r.type).toMatch(/text\/event-stream/);
    expect(r.events).toEqual([{ event: "call_start" }, { event: "live", role: "caller", text: "Hel" },
      { event: "turn", role: "caller", text: "Hello" }, { event: "turn", role: "agent", text: "Hi!" },
      { event: "tool", name: "end_call" }, { event: "call_end" }]);
  });

  it("says no answer when the call never starts", async () => {
    const cookie = await ownerWithCall("call-never");
    const r = await stream(cookie, "call-never");
    expect(r.events).toEqual([{ event: "no_answer" }]);
  });

  it("refuses a bad id, another team's call and a stranger", async () => {
    const cookie = await ownerWithCall("call-live1");
    expect((await stream(cookie, "bad!id")).status).toBe(400);
    expect((await stream(cookie, "call-not-ours")).status).toBe(404);
    expect((await stream("kaho_session=nope", "call-live1")).status).toBe(401);
  });
});

describe("the dashboard", () => {
  it("answers with totals, rates, series, the best hour and the latest calls", async () => {
    const b = await owner();
    await line(b);
    const a = (await b.post("/api/agents").send({ name: "EMI", prompt: "Hi" })).body;
    await talkedCall("call-d001", { agentId: a.id });
    await talkedCall("call-d002", { callerTurns: 1 });
    await internal("put", "/internal/v1/calls/call-d003").send({ ours: OURS, status: "no_answer", peer: "+919000000001", at: at(3), cost: 0.5 });
    await internal("put", "/internal/v1/calls/call-d004").send({ ours: OURS, status: "declined", peer: "+919000000002", at: at(2), direction: "inbound" });
    await internal("put", "/internal/v1/calls/call-d005").send({ ours: OURS, status: "ringing", peer: "+919000000003", at: at(1) });
    await internal("put", "/internal/v1/calls/call-old").send({ ours: OURS, status: "answered", at: "2020-01-01T00:00:00Z" });
    const d = (await b.get("/api/dashboard?days=7")).body;
    expect(d.days).toBe(7);
    expect(d.totals).toEqual({ calls: 5, answered: 2, declined: 1, no_answer: 1, failed: 0, ringing: 1, successful: 1,
      leads: 0, outbound: 4, inbound: 1, people: 4 });
    expect(d.rates).toEqual({ answer: 50, success: 25, conversion: 50 });
    expect(d.talk).toEqual({ avg_secs: 60, total_minutes: 2 });
    expect(d.cost).toBe(0.5);
    expect(d.by_day).toHaveLength(7);
    expect(d.by_day.at(-1).calls).toBeGreaterThanOrEqual(1);
    expect(d.by_hour).toHaveLength(24);
    expect(d.by_agent).toEqual([{ agent_id: a.id, name: "EMI", calls: 1, answered: 1, successful: 1, success_rate: 100 }]);
    expect(d.recent.length).toBe(5);
    expect(d.recent[0].call_id).toBe("call-d005");
    expect((await b.get("/api/dashboard?days=0")).body.error).toBe("days must be between 1 and 365");
    expect((await b.get("/api/dashboard?days=abc")).status).toBe(400);
  });
});
