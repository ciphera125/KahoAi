import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app, db, freshDb, internal, line, member, owner, publish, OURS } from "./helpers.js";

beforeEach(freshDb);
afterEach(() => vi.useRealTimers());

// Monday 9 November 2026, 15:30 India time.
const MONDAY = new Date("2026-11-09T10:00:00Z");
// Only ever called immediately before the one request that has to see this moment:
// faking timers while the database pool is still connecting hangs the run.
const freeze = (when = MONDAY) => { vi.useFakeTimers(); vi.setSystemTime(when); };

const add = (b, body) => b.post("/api/tasks").send(body);

async function contactFor(b, number = "+919876543210") {
  return (await b.post("/api/contacts").send({ name: "Ravi", numbers: [number] })).body;
}

describe("tasks typed into the Studio", () => {
  it("is added, listed and belongs to the organization that made it", async () => {
    const b = await owner();
    const c = await contactFor(b);
    const r = await add(b, { title: "Pay EMI", due_at: "2026-11-12T10:00:00Z", contact_id: c.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: "Pay EMI", status: "pending", source: "studio", contact_id: c.id });
    expect(r.body.id).toMatch(/^tk_[0-9a-f]{12}$/);

    const list = (await b.get("/api/tasks")).body;
    expect(list.items.map((t) => t.title)).toEqual(["Pay EMI"]);
    expect(list.items[0].contact_name).toBe("Ravi");
  });

  it("refuses an empty title and a date it cannot read", async () => {
    const b = await owner();
    expect((await add(b, { title: "   " })).status).toBe(400);
    expect((await add(b, { title: "Pay", due_at: "whenever" })).status).toBe(400);
  });

  it("refuses a contact from another organization", async () => {
    const b = await owner();
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    const theirs = await contactFor(other, "+919000000002");
    expect((await add(b, { title: "Pay", contact_id: theirs.id })).status).toBe(400);
  });

  it("is edited, rescheduled and marked done", async () => {
    const b = await owner();
    const t = (await add(b, { title: "Pay EMI", due_at: "2026-11-12T10:00:00Z" })).body;

    const renamed = await b.patch(`/api/tasks/${t.id}`).send({ title: "Pay the EMI" });
    expect(renamed.body.title).toBe("Pay the EMI");

    const moved = await b.patch(`/api/tasks/${t.id}`).send({ due_at: "2026-11-20T10:00:00Z" });
    expect(moved.body.due_at).toBe("2026-11-20T10:00:00.000Z");

    const done = await b.patch(`/api/tasks/${t.id}`).send({ status: "done" });
    expect(done.body.status).toBe("done");
    expect(done.body.completed_at).toBeTruthy();

    const back = await b.patch(`/api/tasks/${t.id}`).send({ status: "pending" });
    expect(back.body.completed_at).toBeNull();
  });

  it("is deleted, and only by this organization", async () => {
    const b = await owner();
    const t = (await add(b, { title: "Pay" })).body;
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect((await other.delete(`/api/tasks/${t.id}`)).status).toBe(404);
    expect((await b.delete(`/api/tasks/${t.id}`)).status).toBe(200);
    expect((await b.get("/api/tasks")).body.items).toEqual([]);
  });
});

describe("filtering by when it is due, in India's day", () => {
  const atIst = (day, hour = 12) => new Date(Date.UTC(2026, 10, day, hour - 5, 30 - 30)).toISOString();

  async function spread(b) {
    for (const [title, day] of [["Yesterday's", 8], ["Today's", 9], ["Thursday's", 12], ["Next week's", 17]]) {
      await add(b, { title, due_at: atIst(day) });
    }
    await add(b, { title: "No date" });
  }

  it("today means today where the caller is, not in UTC", async () => {
    const b = await owner();
    await spread(b);
    freeze();
    const got = (await b.get("/api/tasks?range=today")).body.items.map((t) => t.title);
    expect(got).toEqual(["Today's"]);
  });

  it("yesterday, this week and everything", async () => {
    const b = await owner();
    await spread(b);
    freeze();
    expect((await b.get("/api/tasks?range=yesterday")).body.items.map((t) => t.title)).toEqual(["Yesterday's"]);
    // The week runs Monday to Sunday: the 9th to the 15th.
    expect((await b.get("/api/tasks?range=this_week")).body.items.map((t) => t.title)).toEqual(["Today's", "Thursday's"]);
    expect((await b.get("/api/tasks")).body.items).toHaveLength(5);
  });

  it("pending and done are separate", async () => {
    const b = await owner();
    const t = (await add(b, { title: "Pay" })).body;
    await b.patch(`/api/tasks/${t.id}`).send({ status: "done" });
    await add(b, { title: "Still to do" });
    expect((await b.get("/api/tasks?status=pending")).body.items.map((t2) => t2.title)).toEqual(["Still to do"]);
    expect((await b.get("/api/tasks?status=done")).body.items.map((t2) => t2.title)).toEqual(["Pay"]);
  });
});

describe("another system pushing tasks in", () => {
  async function keyFor(b) {
    const r = await b.post("/api/api-keys").send({ name: "Our CRM" });
    expect(r.status).toBe(200);
    return r.body;
  }
  // The public API is on the Studio's own port, not the voice service's, and takes a key.
  const push = (key, body) => request(app).post("/api/v1/tasks").set("Authorization", `Bearer ${key}`).send(body);

  it("shows the key once, and never again", async () => {
    const b = await owner();
    const made = await keyFor(b);
    expect(made.key).toMatch(/^kaho_/);
    const listed = (await b.get("/api/api-keys")).body;
    expect(listed[0].key).toBeUndefined();
    expect(listed[0]).toMatchObject({ name: "Our CRM", prefix: made.key.slice(0, 11) });
    const { rows } = await db.query("SELECT key_hash FROM api_keys");
    expect(rows[0].key_hash).not.toContain(made.key);
  });

  it("takes the organization from the key, never from the body", async () => {
    const b = await owner();
    const { key } = await keyFor(b);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });

    const r = await push(key, { title: "From the CRM", org_id: "org_000000000000" });
    expect(r.status).toBe(200);
    expect((await b.get("/api/tasks")).body.items.map((t) => t.title)).toEqual(["From the CRM"]);
    expect((await other.get("/api/tasks")).body.items).toEqual([]);
  });

  it("finds the contact by phone number, inside that organization only", async () => {
    const b = await owner();
    const { key } = await keyFor(b);
    const c = await contactFor(b);
    const r = await push(key, { title: "Call about the loan", phone: "9876543210" });
    expect(r.body.contact_id).toBe(c.id);
  });

  it("pushing the same task twice leaves one", async () => {
    const b = await owner();
    const { key } = await keyFor(b);
    await push(key, { title: "Pay EMI", external_id: "crm-1" });
    await push(key, { title: "Pay EMI (updated)", external_id: "crm-1" });
    const items = (await b.get("/api/tasks")).body.items;
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Pay EMI (updated)");
    expect(items[0].source).toBe("api");
  });

  it("refuses a missing, wrong or revoked key", async () => {
    const b = await owner();
    const { key, id } = await keyFor(b);
    expect((await request(app).post("/api/v1/tasks").send({ title: "x" })).status).toBe(401);
    expect((await push("kaho_nope", { title: "x" })).status).toBe(401);
    await b.delete(`/api/api-keys/${id}`);
    expect((await push(key, { title: "x" })).status).toBe(401);
  });

  it("only an admin can make or revoke a key", async () => {
    const b = await owner();
    const m = await member(b);
    expect((await m.post("/api/api-keys").send({ name: "Mine" })).status).toBe(403);
  });
});

describe("the tools an agent uses on a call", () => {
  const CALL = "22222222-2222-2222-2222-222222222222";

  async function onACall(b) {
    await line(b);
    const c = await contactFor(b);
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call", "get_tasks", "add_task", "reschedule_task", "mark_task_done"] });
    await publish(b, a.id);
    await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: "+919876543210", ours: OURS });
    return { contact: c, agent: a };
  }
  const tool = (name, body) => internal("post", `/internal/v1/calls/${CALL}/tools/${name}`).send(body);

  it("reads back only the tasks of the person on the call", async () => {
    const b = await owner();
    const { contact } = await onACall(b);
    await add(b, { title: "Theirs", contact_id: contact.id, due_at: "2026-11-09T06:00:00Z" });
    await add(b, { title: "Somebody else's" });

    freeze();
    const r = await tool("get_tasks", { range: "today", status: "pending", turn: 1 });
    expect(r.status).toBe(200);
    expect(r.body.tasks.map((t) => t.title)).toEqual(["Theirs"]);
    expect(r.body.tasks[0]).toHaveProperty("due");
    expect(r.body.tasks[0]).not.toHaveProperty("contact_id"); // nothing the agent could read out by mistake
  });

  it("adds a task against the person on the call, reading the date they said", async () => {
    const b = await owner();
    const { contact } = await onACall(b);
    freeze();
    const r = await tool("add_task", { title: "Pay the EMI", due: "next Friday", turn: 3 });
    vi.useRealTimers();
    expect(r.body.ok).toBe(true);
    const { rows } = await db.query("SELECT title, contact_id, source, due_at FROM tasks");
    expect(rows[0]).toMatchObject({ title: "Pay the EMI", contact_id: contact.id, source: "call" });
    expect(rows[0].due_at.toISOString()).toContain("2026-11-20");
  });

  it("will not add the same task twice on one turn", async () => {
    const b = await owner();
    await onACall(b);
    freeze();
    await tool("add_task", { title: "Pay", due: "tomorrow", turn: 4 });
    await tool("add_task", { title: "Pay", due: "tomorrow", turn: 4 });
    vi.useRealTimers();
    expect((await db.query("SELECT 1 FROM tasks")).rowCount).toBe(1);
  });

  it("moves a task the caller asked to move, and marks one done", async () => {
    const b = await owner();
    const { contact } = await onACall(b);
    const t = (await add(b, { title: "Pay EMI", contact_id: contact.id, due_at: "2026-11-10T06:00:00Z" })).body;

    freeze();
    const moved = await tool("reschedule_task", { task_id: t.id, due: "next Friday", turn: 5 });
    expect(moved.body.ok).toBe(true);
    const done = await tool("mark_task_done", { task_id: t.id, turn: 6 });
    expect(done.body.ok).toBe(true);
    vi.useRealTimers();
    const { rows } = await db.query("SELECT status, due_at FROM tasks WHERE id = $1", [t.id]);
    expect(rows[0].status).toBe("done");
    expect(rows[0].due_at.toISOString()).toContain("2026-11-20");
  });

  it("cannot touch a task belonging to anyone but the person on the call", async () => {
    const b = await owner();
    await onACall(b);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    const theirContact = (await other.post("/api/contacts").send({ name: "Them", numbers: ["+919000000003"] })).body;
    const theirs = (await add(other, { title: "Not yours", contact_id: theirContact.id })).body;

    const r = await tool("mark_task_done", { task_id: theirs.id, turn: 1 });
    expect(r.body.ok).toBe(false);
    const { rows } = await db.query("SELECT status FROM tasks WHERE id = $1", [theirs.id]);
    expect(rows[0].status).toBe("pending");
  });

  it("says what to ask when it cannot read the date, instead of guessing", async () => {
    const b = await owner();
    await onACall(b);
    freeze();
    const r = await tool("add_task", { title: "Pay", due: "sometime", turn: 2 });
    vi.useRealTimers();
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/exact date/i);
    expect((await db.query("SELECT 1 FROM tasks")).rowCount).toBe(0);
  });

  it("needs the service token", async () => {
    const r = await internal("post", `/internal/v1/calls/${CALL}/tools/get_tasks`)
      .set("Authorization", "Bearer wrong").send({});
    expect(r.status).toBe(401);
  });
});
