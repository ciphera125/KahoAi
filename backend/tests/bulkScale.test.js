// Bulk calls under load: the concurrency limit holds all the way through a big list,
// every call the voice server carries counts against its capacity (not only bulk ones),
// and a pass of the runner costs the same few queries however many runs wait.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, freshDb, internal, owner } from "./helpers.js";
import { lockPool } from "../src/db/pool.js";
import { startFakes } from "./fakes.js";
import { runLockedPass, runOnce, stopBulkRunner } from "../src/services/bulkRunner.js";

let fakes, seq;
beforeAll(async () => { fakes = await startFakes(); });
afterAll(() => fakes.close());
beforeEach(async () => {
  fakes.plivo.delayMs = 0;
  await freshDb();
  fakes.plivo.requests.length = 0;
  fakes.voice.requests.length = 0;
  seq = 0;
  fakes.plivo.reply = () => ({ status: 201, body: { request_uuid: `req-${String(++seq).padStart(4, "0")}-bulk`, message: "call fired" } });
  fakes.voice.reply = { status: 200, body: '<Response><Stream bidirectional="true">wss://x/ws</Stream></Response>' };
});
afterEach(() => vi.restoreAllMocks());

const NOON = new Date("2026-10-25T06:30:00Z");
const NIGHT = new Date("2026-10-25T20:00:00Z"); // 01:30 in India, outside bulk hours
const tick = (now = NOON) => runOnce({ now });
const dials = () => fakes.plivo.requests.filter((q) => q.method === "POST");
const rows = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ name: `Person ${start + i}`, number: `98765${String(start + i).padStart(5, "0")}` }));
const ended = (n, status = "answered") => internal("put", `/internal/v1/calls/req-${String(n).padStart(4, "0")}-bulk`).send({ status, duration_secs: 20 });
const onTheLine = async () => (await db.query("SELECT count(*)::int AS n FROM bulk_items WHERE status IN ('dialling', 'calling')")).rows[0].n;

async function setup() {
  const b = await owner();
  const n = (await b.post("/api/numbers").send({ provider: "plivo", number: "+918065520552",
    credentials: { auth_id: "MAID123", auth_token: "plivo-token" } })).body;
  const a = (await b.post("/api/agents").send({ name: "EMI reminder", prompt: "You are Riya." })).body;
  return { b, n, a };
}
const start = (b, body) => b.post("/api/bulk-calls").send({ consent: true, parallel: 2, ...body });

describe("50 people, 5 at once", () => {
  it("goes out as ten groups of five, never more than five on the line, each number once", async () => {
    const { b, n, a } = await setup();
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(50), parallel: 5 })).body;
    const sizes = [];
    let worst = 0;
    for (let g = 0; g < 11 && dials().length < 50; g++) {
      const before = dials().length;
      await tick();
      for (let again = 0; again < 3; again++) { await tick(); worst = Math.max(worst, await onTheLine()); }
      sizes.push(dials().length - before);
      for (let k = before + 1; k <= dials().length; k++) await ended(k);
    }
    await tick();
    expect(sizes).toEqual(Array(10).fill(5));
    expect(worst).toBe(5);
    const numbers = dials().map((d) => d.body.to);
    expect(new Set(numbers).size).toBe(50);
    expect((await b.get(`/api/bulk-calls/${run.id}`)).body.status).toBe("done");
  });
});

describe("the voice server's capacity is shared with every other call", () => {
  const live = (id, fields = {}) => db.query(
    `INSERT INTO calls (call_id, status, direction, started_at, ended_at, has_transcript)
     VALUES ($1, $2, 'outbound', $3, $4, $5)`,
    [id, fields.status ?? null, fields.started ?? new Date(), fields.ended ?? null, fields.transcript ?? false]);

  it("a call placed by hand or taken inbound uses a slot a bulk call would have taken", async () => {
    const { b, n, a } = await setup();
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(20), parallel: 10 });
    for (let i = 0; i < 4; i++) await live(`manual-00${i}`, { status: "ringing" });
    for (let i = 0; i < 2; i++) await live(`inbound-00${i}`, { transcript: true }); // on the line, no outcome yet
    await tick();
    expect(dials()).toHaveLength(4); // BULK_MAX_CONCURRENT is 10 and six calls are already live
  });

  it("calls that have ended, and ringing ones long forgotten, take no slot", async () => {
    const { b, n, a } = await setup();
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(20), parallel: 10 });
    await live("done-0001", { status: "answered", ended: new Date() });
    await live("gone-0001", { status: "ringing", started: new Date(Date.now() - 3 * 3600 * 1000) });
    await tick();
    expect(dials()).toHaveLength(10);
  });

  it("a call still ringing after a minute holds no slot (it never connected), one that connected does", async () => {
    const { b, n, a } = await setup();
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(20), parallel: 10 });
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    // What an organization placing many calls nobody answers would leave behind: 12 rows that never connected.
    for (let i = 0; i < 12; i++) await live(`ring-00${String(i).padStart(2, "0")}`, { status: "ringing", started: fiveMinAgo });
    // Two that did connect (the stream started: a transcript line exists) five minutes ago and have not ended.
    for (let i = 0; i < 2; i++) await live(`talk-00${i}`, { status: "ringing", started: fiveMinAgo, transcript: true });
    await tick();
    expect(dials()).toHaveLength(8); // 10 less the two real conversations, not zero
  });

  it("one organization's outside calls can take only part of the capacity, never all of it", async () => {
    const { b, n, a } = await setup();
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(20), parallel: 10 });
    // 25 calls placed by hand in the last minute, all from one place: more than the server could hold anyway.
    for (let i = 0; i < 25; i++) await live(`flood-${String(i).padStart(3, "0")}`, { status: "ringing" });
    await tick();
    expect(dials()).toHaveLength(4); // counted as 6 (BULK_OUTSIDE_CAP), so 4 of 10 are left, not 0
  });

  it("a bulk call already on the line is counted once, not as bulk and as live", async () => {
    const { b, n, a } = await setup();
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(20), parallel: 4 });
    await tick();
    expect(dials()).toHaveLength(4);
    // Every dial leaves a ringing row in calls; those four are the bulk items, not outside calls.
    expect((await db.query("SELECT count(*)::int AS n FROM calls WHERE status = 'ringing'")).rows[0].n).toBe(4);
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(20, 100), parallel: 10 });
    await tick();
    expect(dials()).toHaveLength(4 + 6); // 10 in all, not 10 minus the four counted twice
  });
});

describe("a pass of the runner costs a fixed handful of queries, however many runs wait", () => {
  const touching = (spy) => spy.mock.calls
    .map(([q]) => (typeof q === "string" ? q : q?.text ?? ""))
    .filter((t) => /bulk_(items|runs)/.test(t));

  it("20 runs waiting for their hours are not read or rewritten once each", async () => {
    const { b, n, a } = await setup();
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push((await start(b, { agent_id: a.id, from_id: n.id, rows: rows(1, i * 10), parallel: 1 })).body.id);
    await tick(NIGHT); // says what each is waiting for
    const before = (await db.query("SELECT id, updated_at FROM bulk_runs ORDER BY id")).rows;
    const spy = vi.spyOn(pg.Client.prototype, "query");
    await tick(NIGHT);
    const used = touching(spy);
    spy.mockRestore();
    expect(used.length).toBeLessThanOrEqual(8);
    expect(used.filter((t) => /^\s*UPDATE bulk_runs SET (status|waiting)/i.test(t) && !/status = 'done'/.test(t))).toHaveLength(0);
    const after = (await db.query("SELECT id, updated_at FROM bulk_runs ORDER BY id")).rows;
    expect(after).toEqual(before); // nothing changed, so nothing was written
    expect(ids).toHaveLength(20);
  });

  it("20 runs with calls on the line are settled in a few statements, not four each", async () => {
    const { b, n, a } = await setup();
    for (let i = 0; i < 20; i++) await start(b, { agent_id: a.id, from_id: n.id, rows: rows(1, i * 10), parallel: 1 });
    await tick(); // ten of them dial (the cap), the others wait
    const spy = vi.spyOn(pg.Client.prototype, "query");
    await tick();
    const used = touching(spy);
    spy.mockRestore();
    expect(used.length).toBeLessThanOrEqual(20); // was about 4 settle statements per run plus 3 reads per run
  });
});

describe("stopping the Studio while a bulk call is dialling", () => {
  it("waits for the pass in flight, so every dialled call is recorded as on the line", async () => {
    const { b, n, a } = await setup();
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(4), parallel: 4 });
    fakes.plivo.delayMs = 250; // a slow Plivo: the pass takes about a second
    const pass = runLockedPass({ now: NOON });
    await new Promise((r) => setTimeout(r, 100)); // the first dial is out, the rest not yet
    await stopBulkRunner(); // a deploy: SIGTERM
    const statuses = (await db.query("SELECT status FROM bulk_items ORDER BY position")).rows.map((r) => r.status);
    expect(statuses).toEqual(["calling", "calling", "calling", "calling"]); // none left "may or may not have rung"
    await pass;
  });

  it("does not wait for ever on a pass that is stuck", async () => {
    const { b, n, a } = await setup();
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(2), parallel: 2 });
    fakes.plivo.delayMs = 1500; // Plivo is far slower than the shutdown is willing to wait
    const pass = runLockedPass({ now: NOON });
    await new Promise((r) => setTimeout(r, 100));
    const t = Date.now();
    await stopBulkRunner(200);
    expect(Date.now() - t).toBeLessThan(1000); // gave up waiting; the unfinished dial is handled on the next start
    await pass;
  });
});

describe("a group is dialled together once the first call has shown the line works", () => {
  it("8 people through a slow Plivo take about one dial's time, not eight", async () => {
    const { b, n, a } = await setup();
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(8), parallel: 8 });
    fakes.plivo.delayMs = 300;
    const t = Date.now();
    await tick();
    const took = Date.now() - t;
    expect(dials()).toHaveLength(8);
    expect(took).toBeLessThan(1500); // one after another it would be 2.4 s
    expect((await db.query("SELECT count(*)::int AS n FROM bulk_items WHERE status = 'calling'")).rows[0].n).toBe(8);
  });

  it("if the first call is refused, the others are not tried (nothing is wasted on a broken line)", async () => {
    const { b, n, a } = await setup();
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(8), parallel: 8 })).body;
    fakes.plivo.reply = () => ({ status: 402, body: { error: "insufficient balance" } });
    await tick();
    expect(dials()).toHaveLength(1);
    expect((await b.get(`/api/bulk-calls/${run.id}`)).body.status).toBe("paused");
    expect((await db.query("SELECT count(*)::int AS n FROM bulk_items WHERE status = 'queued'")).rows[0].n).toBe(8);
  });
});

describe("the live view asks for numbers, not 5,000 rows", () => {
  it("?items=0 gives the run and its counts without the rows; the default still has them", async () => {
    const { b, n, a } = await setup();
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(30), parallel: 3 })).body;
    const light = (await b.get(`/api/bulk-calls/${run.id}?items=0`)).body;
    expect(light.items).toBeUndefined();
    expect(light.counts.total).toBe(30);
    const full = (await b.get(`/api/bulk-calls/${run.id}`)).body;
    expect(full.items).toHaveLength(30);
  });

  it("another organization cannot read a run's numbers this way either", async () => {
    const { b, n, a } = await setup();
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(3), parallel: 1 })).body;
    const other = await owner({ email: "spy@other.in", organization: "Other" });
    expect((await other.get(`/api/bulk-calls/${run.id}?items=0`)).status).toBe(404);
    expect((await other.get(`/api/bulk-calls/${run.id}?items[]=0`)).status).toBe(404);
  });
});

describe("the runner's lock does not use a connection the requests need", () => {
  it("holds the advisory lock on its own one-connection pool", async () => {
    const spy = vi.spyOn(lockPool, "connect");
    await runLockedPass({ now: NOON });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(lockPool.options.max).toBe(1);
  });
});
