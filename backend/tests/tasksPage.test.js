// Tasks, made easy to read and right on a call (2026-11-22). Found on the way: the agent was handed due
// dates in UTC ("2026-11-14T19:30:00.000Z" for 1 a.m. on the 15th) and had to work out India's day
// itself; a number saved on two contacts gave the agent either person's list, whichever the database
// found first, so a task read out on one turn could be "not on their list" on the next; and the Tasks
// page stopped at 200 tasks without saying so.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app, db, freshDb, internal, line, owner, publish, OURS } from "./helpers.js";

beforeEach(freshDb);
afterEach(() => vi.useRealTimers());

// Monday 9 November 2026, 15:30 India time.
const MONDAY = new Date("2026-11-09T10:00:00Z");
const freeze = () => { vi.useFakeTimers(); vi.setSystemTime(MONDAY); };
const CALL = "33333333-3333-3333-3333-333333333333";
const add = (b, body) => b.post("/api/tasks").send(body);
const tool = (name, body) => internal("post", `/internal/v1/calls/${CALL}/tools/${name}`).send(body);

async function onACall(b, number = "+919876543210") {
  await line(b);
  const c = (await b.post("/api/contacts").send({ name: "Ravi", numbers: [number] })).body;
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call", "get_tasks", "add_task", "reschedule_task", "mark_task_done"] });
  await publish(b, a.id);
  await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: number, ours: OURS });
  return c;
}

async function moveToEnd(contactId, number) {
  await db.query("UPDATE contact_numbers SET number = number || 'x' WHERE contact_id = $1", [contactId]);
  await db.query("UPDATE contact_numbers SET number = $2 WHERE contact_id = $1", [contactId, number]);
}

describe("what the agent is told on a call", () => {
  it("hears a due date on India's clock, with words it can say, never a UTC instant", async () => {
    const b = await owner();
    const c = await onACall(b);
    // 1 a.m. on Sunday the 15th in India is still the 14th in UTC
    await add(b, { title: "Pay EMI", contact_id: c.id, due_at: "2026-11-14T19:30:00.000Z" });
    freeze();
    const r = await tool("get_tasks", { range: "all", status: "pending", turn: 1 });
    vi.useRealTimers();
    expect(r.body.tasks[0]).toMatchObject({ title: "Pay EMI", due: "2026-11-15T01:00:00+05:30", when: "Sunday 15 November at 1:00 am" });
  });

  it("is told back the day and time it saved, in the same words", async () => {
    const b = await owner();
    await onACall(b);
    freeze();
    const added = (await tool("add_task", { title: "Call the bank", due: "tomorrow at 5 pm", turn: 2 })).body;
    vi.useRealTimers();
    expect(added).toMatchObject({ ok: true, due: "2026-11-10T17:00:00+05:30", when: "Tuesday 10 November at 5:00 pm" });
    const { rows } = await db.query("SELECT due_at FROM tasks");
    expect(rows[0].due_at.toISOString()).toBe("2026-11-10T11:30:00.000Z");
  });

  it("understands 'on Friday' and 'this Friday', which it used to refuse", async () => {
    const b = await owner();
    await onACall(b);
    freeze();
    const r1 = (await tool("add_task", { title: "Gym", due: "on Friday", turn: 3 })).body;
    const r2 = (await tool("add_task", { title: "Job", due: "this Friday", turn: 4 })).body;
    vi.useRealTimers();
    expect([r1.ok, r2.ok]).toEqual([true, true]);
    expect(r1.when).toBe("Friday 13 November at 9:00 am");
  });

  it("asks morning or evening instead of saving a bare hour", async () => {
    const b = await owner();
    await onACall(b);
    freeze();
    const r = (await tool("add_task", { title: "Gym", due: "tomorrow at 6", turn: 3 })).body;
    vi.useRealTimers();
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/morning or the evening/);
    expect((await db.query("SELECT 1 FROM tasks")).rowCount).toBe(0);
  });

  it("moving a task says the new day back, and a wrong id tells it to read the list again", async () => {
    const b = await owner();
    const c = await onACall(b);
    const t = (await add(b, { title: "Pay EMI", contact_id: c.id, due_at: "2026-11-10T06:00:00Z" })).body;
    freeze();
    const moved = (await tool("reschedule_task", { task_id: t.id, due: "Friday evening", turn: 5 })).body;
    const wrong = (await tool("mark_task_done", { task_id: "tk_ffffffffffff", turn: 6 })).body;
    vi.useRealTimers();
    expect(moved).toMatchObject({ ok: true, due: "2026-11-13T18:00:00+05:30", when: "Friday 13 November at 6:00 pm" });
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toMatch(/read their list again/i);
  });

  it("a number saved on two contacts always means the first one saved, on every tool call", async () => {
    const b = await owner();
    const ravi = await onACall(b);
    const wife = (await b.post("/api/contacts").send({ name: "Ravi's wife", numbers: ["+919876543210"] })).body;
    await add(b, { title: "Ravi's task", contact_id: ravi.id });
    await add(b, { title: "Her task", contact_id: wife.id });
    // Rewrite Ravi's number row so it sits after hers in the table and the index, where a lookup without an
    // order finds it last (an update to an indexed column makes a new entry; a plain one would not move it).
    await moveToEnd(ravi.id, "+919876543210");
    for (let turn = 1; turn <= 3; turn++) {
      const r = await tool("get_tasks", { status: "pending", turn });
      expect(r.body.tasks.map((t) => t.title)).toEqual(["Ravi's task"]);
    }
  });

  it("a task pushed in by phone goes to the first contact saved with that number", async () => {
    const b = await owner();
    await b.post("/api/contacts").send({ name: "First", numbers: ["+919811111111"] });
    const second = (await b.post("/api/contacts").send({ name: "Second", numbers: ["+919811111111"] })).body;
    const first = (await db.query("SELECT contact_id FROM contact_numbers WHERE contact_id <> $1", [second.id])).rows[0].contact_id;
    await moveToEnd(first, "+919811111111");
    const key = (await b.post("/api/api-keys").send({ name: "CRM" })).body.key;
    const r = await request(app).post("/api/v1/tasks").set("Authorization", `Bearer ${key}`).send({ title: "Pay", phone: "+919811111111" });
    expect(r.status).toBe(200);
    expect(r.body.contact_name).toBe("First");
  });
});

describe("the Tasks page", () => {
  const atIst = (day, hour = 12) => new Date(Date.UTC(2026, 10, day, hour - 5, 0)).toISOString();

  it("counts what is overdue, due today and due this week, whatever is on screen", async () => {
    const b = await owner();
    for (const [title, d] of [["Late", 5], ["Also late", 8], ["Today", 9], ["Thursday", 12], ["Next week", 17]]) await add(b, { title, due_at: atIst(d) });
    const done = (await add(b, { title: "Done late", due_at: atIst(4) })).body;
    await b.patch(`/api/tasks/${done.id}`).send({ status: "done" });
    await add(b, { title: "No date" });
    freeze();
    const r = (await b.get("/api/tasks?range=today&status=pending&page=1&per_page=10")).body;
    vi.useRealTimers();
    expect(r.items.map((t) => t.title)).toEqual(["Today"]);
    expect(r.counts).toEqual({ overdue: 2, today: 1, this_week: 2, pending: 6, done: 1 });
  });

  it("pages instead of stopping quietly at 200", async () => {
    const b = await owner();
    const values = Array.from({ length: 230 }, (_, i) => `('tk_${String(i).padStart(12, "0")}', $1, 'Task ${String(i).padStart(3, "0")}', 'studio')`);
    const org = (await b.get("/api/me")).body.org_id ?? (await db.query("SELECT id FROM organizations LIMIT 1")).rows[0].id;
    await db.query(`INSERT INTO tasks (id, org_id, title, source) VALUES ${values.join(",")}`, [org]);
    const last = (await b.get("/api/tasks?status=pending&page=5&per_page=50")).body;
    expect(last).toMatchObject({ total: 230, page: 5, per_page: 50 });
    expect(last.items).toHaveLength(30);
    expect((await b.get("/api/tasks?per_page=13")).status).toBe(400);
  });

  it("finds a task by what it says or whose it is", async () => {
    const b = await owner();
    const c = (await b.post("/api/contacts").send({ name: "Meera Iyer", numbers: ["+919822222222"] })).body;
    await add(b, { title: "Pay the November EMI", contact_id: c.id });
    await add(b, { title: "Renew the policy" });
    const titles = async (q) => (await b.get(`/api/tasks?status=all&page=1&per_page=10&q=${encodeURIComponent(q)}`)).body.items.map((t) => t.title);
    expect(await titles("emi")).toEqual(["Pay the November EMI"]);
    expect(await titles("meera")).toEqual(["Pay the November EMI"]);
    expect(await titles("100%_")).toEqual([]); // wildcards are just characters
  });

  it("links a task the agent added to the call it was added on", async () => {
    const b = await owner();
    await onACall(b);
    freeze();
    await tool("add_task", { title: "Call the bank", due: "tomorrow", turn: 2 });
    vi.useRealTimers();
    await add(b, { title: "Typed here" });
    const items = (await b.get("/api/tasks?status=all&page=1&per_page=10")).body.items;
    expect(items.find((t) => t.title === "Call the bank").call_id).toBe(CALL);
    expect(items.find((t) => t.title === "Typed here").call_id).toBeNull();
  });

  it("is never another organization's, counts included", async () => {
    const b = await owner();
    await add(b, { title: "Ours", due_at: atIst(9) });
    const other = await owner({ email: "z@other.in", organization: "Other" });
    const r = (await other.get("/api/tasks?status=all&page=1&per_page=10&q=ours")).body;
    expect(r).toMatchObject({ items: [], total: 0, counts: { pending: 0, done: 0 } });
  });
});
