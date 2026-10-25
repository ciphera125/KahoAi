// Bulk calls: a list of names and numbers, called through one agent, a few at a time.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, member, owner } from "./helpers.js";
import { startFakes } from "./fakes.js";
import { runOnce } from "../src/services/bulkRunner.js";

let fakes, seq;
beforeAll(async () => { fakes = await startFakes(); });
afterAll(() => fakes.close());
beforeEach(async () => {
  await freshDb();
  fakes.plivo.requests.length = 0;
  fakes.voice.requests.length = 0;
  seq = 0;
  // A fresh request id per dial, as Plivo gives.
  fakes.plivo.reply = () => ({ status: 201, body: { request_uuid: `req-${String(++seq).padStart(4, "0")}-bulk`, message: "call fired" } });
  fakes.voice.reply = { status: 200, body: '<Response><Stream bidirectional="true">wss://x/ws</Stream></Response>' };
});

// Noon in India: inside the hours bulk calls keep to, whenever the tests run.
const NOON = new Date("2026-10-25T06:30:00Z");
const tick = (now = NOON) => runOnce({ now });
const dials = () => fakes.plivo.requests.filter((q) => q.method === "POST");
const rows = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ name: `Person ${start + i}`, number: `98765${String(start + i).padStart(5, "0")}` }));

async function setup() {
  const b = await owner();
  const n = (await b.post("/api/numbers").send({ provider: "plivo", number: "+918065520552",
    credentials: { auth_id: "MAID123", auth_token: "plivo-token" } })).body;
  const a = (await b.post("/api/agents").send({ name: "EMI reminder", prompt: "You are Riya." })).body;
  return { b, n, a };
}

async function start(b, body) {
  return b.post("/api/bulk-calls").send({ consent: true, parallel: 2, ...body });
}

describe("starting a bulk call", () => {
  it("needs consent, an agent of this team, and at least one row", async () => {
    const { b, n, a } = await setup();
    expect((await b.post("/api/bulk-calls").send({ agent_id: a.id, from_id: n.id, rows: rows(1) })).status).toBe(400);
    expect((await start(b, { agent_id: "ag_000000000000", from_id: n.id, rows: rows(1) })).status).toBe(400);
    expect((await start(b, { agent_id: a.id, from_id: n.id, rows: [] })).status).toBe(400);
  });

  it("queues every valid row, skips bad numbers and repeats, and says why", async () => {
    const { b, n, a } = await setup();
    const r = await start(b, { agent_id: a.id, from_id: n.id, name: "October EMIs",
      rows: [...rows(2), { name: "Bad", number: "12" }, { name: "Again", number: "9876500000" }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "October EMIs", agent_name: "EMI reminder", status: "running", parallel: 2,
      counts: { queued: 2, skipped: 2 } });
    const items = (await b.get(`/api/bulk-calls/${r.body.id}`)).body.items;
    expect(items.map((i) => [i.name, i.number, i.status])).toEqual([
      ["Person 0", "+919876500000", "queued"], ["Person 1", "+919876500001", "queued"],
      ["Bad", "12", "skipped"], ["Again", "+919876500000", "skipped"]]);
    expect(items[2].reason).toMatch(/not a phone number/);
    expect(items[3].reason).toMatch(/already in this list/);
    expect(dials()).toHaveLength(0); // starting it dials no one; the runner does
  });

  it("adds people not yet in Contacts, by the name in the file, and leaves existing ones alone", async () => {
    const { b, n, a } = await setup();
    await b.post("/api/contacts").send({ name: "Asha Rao", numbers: ["9876500000"] });
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(2) });
    const { rows: people } = await db.query("SELECT c.name, n.number FROM contacts c JOIN contact_numbers n ON n.contact_id = c.id ORDER BY n.number");
    expect(people).toEqual([{ name: "Asha Rao", number: "+919876500000" }, { name: "Person 1", number: "+919876500001" }]);
  });

  it("refuses more than the parallel limit and a file that is too long", async () => {
    const { b, n, a } = await setup();
    expect((await start(b, { agent_id: a.id, from_id: n.id, rows: rows(1), parallel: 11 })).status).toBe(400);
    expect((await start(b, { agent_id: a.id, from_id: n.id, rows: rows(1), parallel: 0 })).status).toBe(400);
    const big = await start(b, { agent_id: a.id, from_id: n.id, rows: rows(5001) });
    expect(big.status).toBe(400);
    expect(big.body.error).toMatch(/5000/);
  });
});

describe("running a bulk call", () => {
  it("dials at most `parallel` at once, through the agent, and the next only when one ends", async () => {
    const { b, n, a } = await setup();
    await b.patch(`/api/agents/${a.id}`).send({ settings: { ring_secs: 40, max_minutes: 10 } });
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(5), parallel: 2 })).body;
    await tick();
    expect(dials()).toHaveLength(2);
    expect(dials()[0].body).toMatchObject({ to: "+919876500000", ring_timeout: 40, time_limit: 615 });
    expect(dials()[0].body.answer_url).toContain(`studio_agent=${a.id}`);
    await tick();
    expect(dials()).toHaveLength(2); // both still on the line
    // The voice service reports the first one ended.
    await internal("put", "/internal/v1/calls/req-0001-bulk").send({ status: "answered", duration_secs: 42 });
    await tick();
    expect(dials()).toHaveLength(3);
    const detail = (await b.get(`/api/bulk-calls/${run.id}`)).body;
    expect(detail.counts).toMatchObject({ done: 1, calling: 2, queued: 2 });
    expect(detail.items[0]).toMatchObject({ status: "done", outcome: "answered", call_id: "req-0001-bulk" });
  });

  it("finishes when every row is done", async () => {
    const { b, n, a } = await setup();
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(2), parallel: 2 })).body;
    await tick();
    for (const id of ["req-0001-bulk", "req-0002-bulk"]) await internal("put", `/internal/v1/calls/${id}`).send({ status: "no_answer" });
    await tick();
    const detail = (await b.get(`/api/bulk-calls/${run.id}`)).body;
    expect(detail.status).toBe("done");
    expect(detail.counts).toMatchObject({ done: 2 });
  });

  it("never dials a Do not call number, and never retries a failed dial", async () => {
    const { b, n, a } = await setup();
    const c = (await b.post("/api/contacts").send({ name: "No calls", numbers: ["9876500000"] })).body;
    await b.patch(`/api/contacts/${c.id}`).send({ dnc: true });
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(3), parallel: 5 })).body;
    fakes.plivo.reply = { status: 400, body: { error: "invalid destination" } };
    await tick();
    await tick();
    expect(dials()).toHaveLength(2); // the Do not call row was never dialled; each failure once
    const items = (await b.get(`/api/bulk-calls/${run.id}`)).body.items;
    expect(items.map((i) => i.status)).toEqual(["skipped", "failed", "failed"]);
    expect(items[0].reason).toMatch(/Do not call/);
    expect(items[1].reason).toMatch(/Plivo refused/);
  });

  it("waits outside the agent's calling window instead of dialling", async () => {
    const { b, n, a } = await setup();
    await b.patch(`/api/agents/${a.id}`).send({ settings: { call_window: { enabled: true, start: "14:00", end: "15:00" } } });
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(2) })).body;
    await tick();
    expect(dials()).toHaveLength(0);
    const detail = (await b.get(`/api/bulk-calls/${run.id}`)).body;
    expect(detail.status).toBe("running");
    expect(detail.waiting).toMatch(/calling window/);
  });

  it("stops dialling when paused or cancelled, and resumes", async () => {
    const { b, n, a } = await setup();
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(4), parallel: 1 })).body;
    expect((await b.post(`/api/bulk-calls/${run.id}/pause`)).body.status).toBe("paused");
    await tick();
    expect(dials()).toHaveLength(0);
    await b.post(`/api/bulk-calls/${run.id}/resume`);
    await tick();
    expect(dials()).toHaveLength(1);
    expect((await b.post(`/api/bulk-calls/${run.id}/cancel`)).body.status).toBe("cancelled");
    await internal("put", "/internal/v1/calls/req-0001-bulk").send({ status: "answered" });
    await tick();
    expect(dials()).toHaveLength(1);
    const items = (await b.get(`/api/bulk-calls/${run.id}`)).body.items;
    expect(items.filter((i) => i.status === "skipped").every((i) => /cancelled/.test(i.reason))).toBe(true);
  });

  it("pauses with the reason when the voice server is down, instead of failing every row", async () => {
    const { b, n, a } = await setup();
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(3) })).body;
    fakes.voice.reply = { status: 503, body: "down" };
    await tick();
    expect(dials()).toHaveLength(0);
    const detail = (await b.get(`/api/bulk-calls/${run.id}`)).body;
    expect(detail.status).toBe("paused");
    expect(detail.waiting).toMatch(/Nothing was dialled/);
    expect(detail.counts).toMatchObject({ queued: 3, failed: 0 });
    // Rows taken for this pass but not dialled go back to waiting, not stuck on "Dialling".
    expect(detail.items.map((i) => i.status)).toEqual(["queued", "queued", "queued"]);
  });

  it("a row left mid-dial by a server that stopped is failed, never dialled again", async () => {
    const { b, n, a } = await setup();
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(2), parallel: 1 })).body;
    await db.query("UPDATE bulk_items SET status = 'dialling', placed_at = now() - interval '10 minutes' WHERE position = 0");
    await tick();
    const items = (await b.get(`/api/bulk-calls/${run.id}`)).body.items;
    expect(items[0]).toMatchObject({ status: "failed" });
    expect(items[0].reason).toMatch(/Check Plivo/);
    expect(dials().map((d) => d.body.to)).toEqual(["+919876500001"]);
  });

  it("gives up waiting on a call that never reports an end, so the run cannot stall", async () => {
    const { b, n, a } = await setup();
    await b.patch(`/api/agents/${a.id}`).send({ settings: { max_minutes: 1, ring_secs: 15 } });
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(2), parallel: 1 })).body;
    await tick();
    await db.query("UPDATE bulk_items SET placed_at = now() - interval '1 hour' WHERE status = 'calling'");
    await tick();
    expect(dials()).toHaveLength(2);
    const items = (await b.get(`/api/bulk-calls/${run.id}`)).body.items;
    expect(items[0]).toMatchObject({ status: "done", outcome: "unknown" });
  });
});

describe("who sees a bulk call", () => {
  it("only its own organization", async () => {
    const { b, n, a } = await setup();
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(1) })).body;
    const other = await owner({ email: "x@other.in", organization: "Other" });
    expect((await other.get(`/api/bulk-calls/${run.id}`)).status).toBe(404);
    expect((await other.get("/api/bulk-calls")).body).toEqual([]);
    expect((await other.post(`/api/bulk-calls/${run.id}/cancel`)).status).toBe(404);
    expect((await b.get("/api/bulk-calls")).body.map((r) => r.id)).toEqual([run.id]);
  });

  it("a member can start and watch one too", async () => {
    const { b, n, a } = await setup();
    const m = await member(b);
    expect((await start(m, { agent_id: a.id, from_id: n.id, rows: rows(1) })).status).toBe(200);
  });
});

describe("the findings of 2026-10-25, fixed", () => {
  it("someone already called in the last 24 hours, by any bulk call or by hand, is not called again", async () => {
    const { b, n, a } = await setup();
    const first = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(1), name: "First list" })).body;
    await tick();
    const second = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(2), name: "Second list" })).body;
    await tick();
    expect(dials().map((d) => d.body.to)).toEqual(["+919876500000", "+919876500001"]);
    const items = (await b.get(`/api/bulk-calls/${second.id}`)).body.items;
    expect(items[0]).toMatchObject({ status: "skipped" });
    expect(items[0].reason).toMatch(/already called in the last 24 hours/);
    expect(first.id).not.toBe(second.id);
  });

  it("with the agent's calling window off, bulk calls still keep to 09:00-21:00 India time", async () => {
    const { b, n, a } = await setup();
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(1) })).body;
    await tick(new Date("2026-10-25T18:00:00Z")); // 23:30 in India
    expect(dials()).toHaveLength(0);
    expect((await b.get(`/api/bulk-calls/${run.id}`)).body.waiting).toMatch(/09:00.21:00/);
    await tick(); // noon
    expect(dials()).toHaveLength(1);
  });

  it("a number of another organization, or one that cannot call, is refused when the run is made", async () => {
    const { b, a } = await setup();
    const other = await owner({ email: "x@other.in", organization: "Other" });
    const theirs = (await other.post("/api/numbers").send({ provider: "plivo", number: "+918065520553",
      credentials: { auth_id: "OID", auth_token: "otok" } })).body;
    const r = await start(b, { agent_id: a.id, from_id: theirs.id, rows: rows(1) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/number to call from/);
    expect((await start(b, { agent_id: a.id, from_id: "nope", rows: rows(1) })).status).toBe(400);
  });

  it("organizations share the call slots fairly: one big run cannot take all of them", async () => {
    const { b, n, a } = await setup();
    const other = await owner({ email: "x@other.in", organization: "Other" });
    const on = (await other.post("/api/numbers").send({ provider: "plivo", number: "+918065520553",
      credentials: { auth_id: "OID", auth_token: "otok" } })).body;
    const oa = (await other.post("/api/agents").send({ name: "Other agent", prompt: "Hi" })).body;
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(12), parallel: 10 });
    await start(other, { agent_id: oa.id, from_id: on.id, rows: rows(12, 100), parallel: 10 });
    await tick();
    const byOrg = { ours: 0, theirs: 0 };
    for (const d of dials()) byOrg[d.body.from === "+918065520552" ? "ours" : "theirs"] += 1;
    expect(byOrg).toEqual({ ours: 5, theirs: 5 }); // BULK_MAX_CONCURRENT is 10
  });
});
