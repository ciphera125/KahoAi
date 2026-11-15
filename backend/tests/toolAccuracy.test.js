// The tool history and the tools behind it must say what happened (found 2026-11-15): two different tasks
// asked for in one sentence were one task with the second's name; a tool the organization made showed under
// its raw name; the date filter cut the day at midnight in London, not India; "they said" came from a count
// that drifts when a spoken number is joined into one line; and a filtered list lost the other tools.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, line, owner, publish, OURS } from "./helpers.js";

beforeEach(freshDb);

const CALL = "66666666-6666-6666-6666-666666666666";
const T = (s, base = "2026-11-08T10:00") => `${base}:${String(s).padStart(2, "0")}.000Z`;

async function aCall(b) {
  await line(b);
  await b.post("/api/contacts").send({ name: "Ravi", numbers: ["+919876543210"] });
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  await publish(b, a.id).catch(() => {});
  await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: "+919876543210", ours: OURS, agent_id: a.id });
  return a;
}
const tool = (name, turn, text, extra = {}) => ({ event: "tool", name, turn, ok: true, seconds: 0.3, text, ...extra });
const history = async (b, query = "") => (await b.get(`/api/calls/tools${query}`)).body;

describe("tasks asked for during a call", () => {
  const add = (body) => internal("post", `/internal/v1/calls/${CALL}/tools/add_task`).send(body);

  it("two different tasks in one turn are two tasks", async () => {
    const b = await owner();
    await aCall(b);
    const milk = (await add({ title: "Buy milk", turn: 3 })).body;
    const eggs = (await add({ title: "Book the eggs", turn: 3 })).body;
    expect(milk.ok && eggs.ok).toBe(true);
    expect(eggs.task_id).not.toBe(milk.task_id);
    const titles = (await b.get("/api/tasks")).body.items.map((t) => t.title).sort();
    expect(titles).toEqual(["Book the eggs", "Buy milk"]);
  });

  it("the same task sent twice in one turn is still one task, and keeps its first words", async () => {
    const b = await owner();
    await aCall(b);
    const first = (await add({ title: "Buy milk", turn: 3 })).body;
    const again = (await add({ title: "  buy   MILK ", turn: 3 })).body;
    expect(again.task_id).toBe(first.task_id);
    expect((await b.get("/api/tasks")).body.items).toHaveLength(1);
    expect((await b.get("/api/tasks")).body.items[0].title).toBe("Buy milk");
  });

  it("the same words on a later turn are a new task: the caller asked again", async () => {
    const b = await owner();
    await aCall(b);
    const a1 = (await add({ title: "Buy milk", turn: 3 })).body;
    const a2 = (await add({ title: "Buy milk", turn: 5 })).body;
    expect(a2.task_id).not.toBe(a1.task_id);
  });
});

describe("what the history says about each tool call", () => {
  it("shows a tool the organization made by its own label, not its internal name", async () => {
    const b = await owner();
    await aCall(b);
    const made = (await b.post("/api/custom-tools").send({ label: "Check stock", description: "Use when asked about stock.",
      url: "https://api.example.com/stock", method: "POST", inputs: [{ label: "Item", type: "text" }] })).body;
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
      { event: "call_start", at: T(0) }, { event: "turn", role: "user", text: "Do you have shoes?", at: T(1) },
      tool(made.name, 1, '{"args":{"item":"shoes"},"result":{"ok":true}}', { at: T(2) })] });
    const call = (await history(b)).calls[0];
    expect(call.turns[0].calls[0]).toMatchObject({ tool: made.name, label: "Check stock", status: "worked" });
  });

  it("calls a successful document search a success, whatever an older version recorded", async () => {
    const b = await owner();
    await aCall(b);
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
      { event: "call_start", at: T(0) }, { event: "turn", role: "user", text: "What are the fees?", at: T(1) },
      // ok:false is what the voice service used to write for this
      tool("search_knowledge", 1, '{"args":{"question":"fees"},"result":{"found": true, "passages": ["500 a month"], "what_to_do": "Answer only from these passages"}}', { ok: false, at: T(2) }),
      { event: "turn", role: "user", text: "And the moon?", at: T(3) },
      tool("search_knowledge", 2, '{"args":{"question":"moon"},"result":{"found": false, "what_to_do": "I do not have that in my documents."}}', { ok: false, at: T(4) }),
      tool("get_tasks", 2, '{"args":{},"result":{"what_to_do":"I could not read the list just now."}}', { ok: false, at: T(5) })] });
    const turns = (await history(b)).calls[0].turns;
    expect(turns[0].calls[0].status).toBe("worked");
    expect(turns[1].calls.map((c) => [c.tool, c.status])).toEqual([["search_knowledge", "worked"], ["get_tasks", "failed"]]);
  });

  it("the migration corrects the rows older versions wrote", async () => {
    const b = await owner();
    await aCall(b);
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
      { event: "call_start", at: T(0) },
      tool("search_knowledge", 1, '{"args":{},"result":{"found": true, "passages": ["x"], "what_to_do": "Answer only"}}', { ok: false, at: T(1) }),
      tool("get_tasks", 1, '{"args":{},"result":{"what_to_do":"could not"}}', { ok: false, at: T(2) })] });
    const sql = readFileSync(new URL("../src/db/migrations/029_tool_success_fix.sql", import.meta.url), "utf8");
    await db.query(sql);
    const rows = (await db.query("SELECT name, ok FROM call_events WHERE event = 'tool' ORDER BY id")).rows;
    expect(rows).toEqual([{ name: "search_knowledge", ok: true }, { name: "get_tasks", ok: false }]);
    await db.query(sql); // safe to run twice
  });

  it("says what the caller said just before, even when a spoken number was joined into one line", async () => {
    const b = await owner();
    await aCall(b);
    // The voice service counted three fragments ("9 8 7", "6 5 4", "3 2 1") but wrote one masked line.
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
      { event: "call_start", at: T(0) }, { event: "turn", role: "user", text: "Hello", at: T(1) },
      { event: "turn", role: "user", text: "My number is XXXX XXXX 1234", at: T(2) },
      tool("capture_lead", 4, '{"args":{},"result":{"status":"saved"}}', { at: T(3) })] });
    const turn = (await history(b)).calls[0].turns[0];
    expect(turn.turn).toBe(4);
    expect(turn.said).toBe("My number is XXXX XXXX 1234");
  });

  it("reads 'from' and 'to' as days in India, as the dashboard and the audit log do", async () => {
    const b = await owner();
    await aCall(b);
    // 20:00 UTC on 8 November is 01:30 on 9 November in India.
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
      { event: "call_start", at: "2026-11-08T19:59:00.000Z" },
      tool("end_call", 1, '{"args":{},"result":{"status":"ending"}}', { at: "2026-11-08T20:00:00.000Z" })] });
    expect((await history(b, "?from=2026-11-09&to=2026-11-09")).calls).toHaveLength(1);
    expect((await history(b, "?from=2026-11-08&to=2026-11-08")).calls).toHaveLength(0);
    expect((await history(b, "?from=2026-11-10")).calls).toHaveLength(0);
    for (const bad of ["?from=yesterday", "?to=2026-02-31", "?from=2026-11-09&to=2026-11-01"]) {
      expect((await b.get(`/api/calls/tools${bad}`)).status, bad).toBe(400);
    }
  });

  it("says how many there are and whether the list was cut, and lists every tool whatever is filtered", async () => {
    const b = await owner();
    await aCall(b);
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
      { event: "call_start", at: T(0) }, { event: "turn", role: "user", text: "Hi", at: T(1) },
      tool("get_tasks", 1, '{"args":{},"result":{"count":0}}', { at: T(2) }),
      tool("add_task", 1, '{"args":{},"result":{"ok":true}}', { at: T(3) }),
      tool("end_call", 1, '{"args":{},"result":{"status":"ending"}}', { at: T(4) })] });
    const cut = await history(b, "?limit=2");
    expect(cut).toMatchObject({ total: 3, shown: 2, truncated: true });
    const all = await history(b);
    expect(all).toMatchObject({ total: 3, shown: 3, truncated: false });
    const onlyOne = await history(b, "?tool=get_tasks");
    expect(onlyOne.calls[0].turns[0].calls).toHaveLength(1);
    expect(onlyOne.tools.map((t) => t.name)).toEqual(["add_task", "end_call", "get_tasks"]); // still every tool
    expect(onlyOne.tools.find((t) => t.name === "get_tasks").label).toBe("Read out their tasks");
    expect(onlyOne.total).toBe(1);
  });

  it("is never another organization's, for the new counts and tool list either", async () => {
    const b = await owner();
    await aCall(b);
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [{ event: "call_start", at: T(0) }, tool("get_tasks", 1, "{}", { at: T(1) })] });
    const other = await owner({ email: "z@other.in", organization: "Other" });
    expect(await history(other)).toMatchObject({ calls: [], tools: [], total: 0, shown: 0, truncated: false });
  });
});
