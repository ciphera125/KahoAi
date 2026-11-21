// The Tool calls page, rebuilt to be read by the person who runs the business (2026-11-22).
// Found on the way: the list was cut at the newest 100 tool calls, so the oldest call on screen could
// show fewer tool calls than it had; a number saved on two contacts showed every tool call twice; a
// refused attempt sat apart from the turn it happened on; an old row with no result read as "Worked".
import { beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, line, owner, OURS } from "./helpers.js";
import * as Call from "../src/models/Call.js";
import { backfillToolOutcomes, OUTCOME_VERSION } from "../src/services/toolOutcomes.js";

beforeEach(freshDb);

const id = (n) => `55555555-5555-5555-5555-${String(n).padStart(12, "0")}`;
const T = (n, s) => `2026-11-08T10:${String(n).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
const tool = (name, turn, args, result, at, ok = undefined) => ({ event: "tool", name, turn, seconds: 0.2, at,
  ok: ok ?? !("error" in result || Object.values(result).includes(false) || ("what_to_do" in result && !("found" in result))),
  text: JSON.stringify({ args, result }) });
const history = async (b, q = "") => (await b.get(`/api/calls/tools${q}`)).body;

async function setUp(b, { tools } = {}) {
  await line(b);
  await b.post("/api/contacts").send({ name: "Ravi", numbers: ["+919876543210"] });
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  if (tools) await b.patch(`/api/agents/${a.id}`).send({ tools });
  return a;
}

async function aCall(agent, n, events, peer = "+919876543210") {
  await internal("put", `/internal/v1/calls/${id(n)}`).send({ status: "answered", peer, ours: OURS, agent_id: agent.id });
  const r = await internal("post", `/internal/v1/calls/${id(n)}/events`).send({ events: [{ event: "call_start", at: T(n, 0) }, ...events] });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
}

describe("what each tool call came to, kept when it arrives", () => {
  it("stores the outcome beside the line, using the tools the agent had on that call", async () => {
    const b = await owner();
    const a = await setUp(b, { tools: ["end_call", "capture_lead", "get_tasks"] });
    await aCall(a, 1, [
      { event: "turn", role: "user", text: "What do I have today?", at: T(1, 1) },
      tool("get_tasks", 1, { range: "today" }, { tasks: [], count: 0 }, T(1, 2)),
      tool("end_call", 1, {}, { error: "the caller has not said goodbye, so do not hang up; keep helping" }, T(1, 3)),
      { event: "tool_rejected", tool: "get_balance", reason: "Error code: 400 -", at: T(1, 4) },
      { event: "tool_rejected", tool: "capture_lead", reason: "Error code: 400 -", at: T(1, 5) },
    ]);
    const { rows } = await db.query("SELECT name, outcome FROM call_events WHERE event IN ('tool', 'tool_rejected') ORDER BY id");
    expect(rows).toEqual([
      { name: "get_tasks", outcome: "worked" },
      { name: "end_call", outcome: "blocked" },
      { name: "get_balance", outcome: "not_attached" },
      { name: "capture_lead", outcome: "failed" }, // it had the tool; the details it sent did not fit
    ]);
  });
});

describe("the history, a whole call at a time", () => {
  it("pages by call, so no call is ever cut in half, and counts are exact", async () => {
    const b = await owner();
    const a = await setUp(b);
    for (let n = 1; n <= 12; n++) {
      await aCall(a, n, [
        { event: "turn", role: "user", text: `Hello ${n}`, at: T(n, 1) },
        tool("capture_lead", 1, { name: "Ravi", reason: "Loan" }, { status: "saved" }, T(n, 2)),
        tool("end_call", 2, {}, { status: "ending" }, T(n, 3)),
      ]);
    }
    const first = await history(b, "?per_page=10");
    expect(first).toMatchObject({ page: 1, per_page: 10, calls_total: 12, total: 24 });
    expect(first.calls).toHaveLength(10);
    expect(first.calls[0].call_id).toBe(id(12)); // newest first
    for (const call of first.calls) expect(call.turns.flatMap((t) => t.calls)).toHaveLength(2);
    const second = await history(b, "?per_page=10&page=2");
    expect(second.calls.map((c) => c.call_id)).toEqual([id(2), id(1)]);
    expect((await b.get("/api/calls/tools?per_page=7")).status).toBe(400);
    expect((await history(b, "?page=-3")).page).toBe(1); // an odd page is page 1, as everywhere in the Studio
  });

  it("sums up every matching tool call, not only the ones on this page", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [
      tool("capture_lead", 1, {}, { error: "a name and a reason are both needed; ask the caller for the missing one" }, T(1, 1)),
      tool("capture_lead", 2, { name: "Ravi", reason: "Loan" }, { status: "saved" }, T(1, 2)),
      { event: "tool_rejected", tool: "get_balance", reason: "x", at: T(1, 3) },
    ]);
    await aCall(a, 2, [tool("end_call", 1, {}, { status: "ending" }, T(2, 1))]);
    const { summary } = await history(b, "?per_page=10");
    expect(summary).toMatchObject({ total: 4, worked: 2, held: 1, attention: 1, unknown: 0 });
    expect(summary.by_tool.find((t) => t.name === "capture_lead")).toMatchObject({ label: "Save details", total: 2, worked: 1, held: 1, attention: 0 });
  });

  it("filters by what it came to: worked, needs your attention, or held back on purpose", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [
      tool("end_call", 1, {}, { error: "the caller has not said goodbye, so do not hang up" }, T(1, 1)),
      tool("call_webhook", 1, { action: "check" }, { error: "the business system did not answer; tell the caller you could not" }, T(1, 2)),
      tool("end_call", 2, {}, { status: "ending" }, T(1, 3)),
    ]);
    const outcomes = async (q) => (await history(b, q)).calls.flatMap((c) => c.turns.flatMap((t) => t.calls.map((x) => x.outcome)));
    expect(await outcomes("?outcome=attention")).toEqual(["failed"]);
    expect(await outcomes("?outcome=held")).toEqual(["blocked"]);
    expect(await outcomes("?outcome=worked")).toEqual(["worked"]);
    expect((await b.get("/api/calls/tools?outcome=everything")).status).toBe(400);
  });

  it("puts each tool call under what the caller had just said, a refused attempt included", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [
      tool("look_up_contact", 0, {}, { name: "Ravi" }, T(1, 1)),
      { event: "turn", role: "user", text: "Move my EMI to Friday", at: T(1, 2) },
      tool("reschedule_task", 1, { task_id: "tk_000000000001" }, { moved: false, what_to_do: "I could not find that task on their list. Please check with them." }, T(1, 3)),
      { event: "tool_rejected", tool: "get_balance", reason: "x", at: T(1, 4) },
    ]);
    const [call] = (await history(b)).calls;
    expect(call.turns.map((t) => t.said)).toEqual([null, "Move my EMI to Friday"]);
    expect(call.turns[1].calls.map((c) => c.tool)).toEqual(["reschedule_task", "get_balance"]);
  });

  it("shows each tool call once when its number is saved on two contacts, under the first contact's name", async () => {
    const b = await owner();
    const a = await setUp(b);
    await b.post("/api/contacts").send({ name: "Ravi's wife", numbers: ["+919876543210"] });
    await aCall(a, 1, [tool("end_call", 1, {}, { status: "ending" }, T(1, 1))]);
    const page = await history(b);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0].contact_name).toBe("Ravi");
    expect(page.calls[0].turns.flatMap((t) => t.calls)).toHaveLength(1);
    expect(page.total).toBe(1);
    expect((await history(b, "?contact=wife")).calls).toHaveLength(1); // either name finds it
  });

  it("finds a number however it is typed", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [tool("end_call", 1, {}, { status: "ending" }, T(1, 1))]);
    for (const typed of ["98765 43210", "+91 98765-43210", "43210", "Ravi"]) {
      expect((await history(b, `?contact=${encodeURIComponent(typed)}`)).calls, typed).toHaveLength(1);
    }
    expect((await history(b, "?contact=12345")).calls).toHaveLength(0);
  });

  it("says which tools the agent had on that call, so a missing one is plain to see", async () => {
    const b = await owner();
    const a = await setUp(b, { tools: ["end_call", "capture_lead"] });
    await aCall(a, 1, [tool("end_call", 1, {}, { status: "ending" }, T(1, 1))]);
    const [call] = (await history(b)).calls;
    expect(call.tools_available).toEqual([{ name: "end_call", label: "End the call" }, { name: "capture_lead", label: "Save details" }]);
  });

  it("gives each tool call its outcome, a plain summary, and the reason and fix only when they help", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [
      tool("capture_lead", 1, { name: "Ravi", reason: "Wants a loan" }, { status: "saved", phone_saved: "XXXXXX3210" }, T(1, 1)),
      tool("search_knowledge", 1, { question: "fees" }, { found: true, passages: ["500"], what_to_do: "Answer only from these passages" }, T(1, 2)),
      tool("call_webhook", 1, { action: "check" }, { error: "the business system did not answer; tell the caller you could not" }, T(1, 3)),
    ]);
    const [lead, search, hook] = (await history(b)).calls[0].turns.flatMap((t) => t.calls);
    expect(lead).toMatchObject({ outcome: "worked", outcome_label: "Worked", attention: false, status: "worked",
      summary: "Saved their details: Ravi, “Wants a loan”.", why: null, fix: null });
    expect(search).toMatchObject({ outcome: "worked", why: null });
    expect(hook).toMatchObject({ outcome: "failed", outcome_label: "Failed", attention: true, status: "failed",
      summary: "Could not reach your system.", why: "Your system did not answer." });
    expect(hook.fix).toMatch(/running/);
  });

  it("names the task a reschedule moved, from the task list itself", async () => {
    const b = await owner();
    const a = await setUp(b);
    const contact = (await b.get("/api/contacts")).body.contacts[0];
    const task = (await b.post("/api/tasks").send({ title: "Pay EMI", contact_id: contact.id })).body;
    await aCall(a, 1, [tool("reschedule_task", 1, { task_id: task.id, due: "Friday" }, { moved: true, due: "2026-11-20T03:30:00.000Z" }, T(1, 1))]);
    const [moved] = (await history(b)).calls[0].turns.flatMap((t) => t.calls);
    expect(moved.summary).toBe("Moved “Pay EMI” to Fri 20 Nov, 9:00 am.");
  });

  it("is never another organization's: not the calls, the counts, nor the task names", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [tool("end_call", 1, {}, { status: "ending" }, T(1, 1))]);
    const other = await owner({ email: "z@other.in", organization: "Other" });
    expect(await history(other)).toMatchObject({ calls: [], calls_total: 0, total: 0, summary: { total: 0 } });
    expect((await other.get(`/api/calls/${id(1)}`)).status).toBe(404);
    expect((await other.get(`/api/calls/${id(1)}/tools`)).status).toBe(404);
  });
});

describe("one call, opened", () => {
  it("is fetched by its id, shaped like a row of the call list", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [{ event: "turn", role: "user", text: "Hi", at: T(1, 1) }, { event: "call_end", at: T(1, 9) }]);
    const r = await b.get(`/api/calls/${id(1)}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ call_id: id(1), peer: "+919876543210", contact_name: "Ravi", agent_name: "Ria", has_transcript: true });
    expect((await b.get("/api/calls/not-a-call-id!")).status).toBe(404);
    expect((await b.get(`/api/calls/${id(99)}`)).status).toBe(404);
  });

  it("lists that call's own tool calls, in the shape the history uses", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [{ event: "turn", role: "user", text: "Bye", at: T(1, 1) }, tool("end_call", 1, {}, { status: "ending" }, T(1, 2))]);
    await aCall(a, 2, [tool("end_call", 1, {}, { status: "ending" }, T(2, 1))]);
    const r = await b.get(`/api/calls/${id(1)}/tools`);
    expect(r.status).toBe(200);
    expect(r.body.call_id).toBe(id(1));
    expect(r.body.turns.flatMap((t) => t.calls).map((c) => c.summary)).toEqual(["Ended the call after the goodbye."]);
  });

  it("gives every transcript line its place, so tool calls can be shown where they happened", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [
      { event: "turn", role: "user", text: "Bye", at: T(1, 1) },
      tool("end_call", 1, {}, { status: "ending" }, T(1, 2)),
      { event: "turn", role: "assistant", text: "Goodbye!", at: T(1, 3) },
    ]);
    const turns = (await b.get(`/api/calls/${id(1)}/transcript`)).body;
    const tools = (await b.get(`/api/calls/${id(1)}/tools`)).body.turns.flatMap((t) => t.calls);
    expect(turns.map((t) => typeof t.seq)).toEqual(["number", "number"]);
    expect(turns[0].seq).toBeLessThan(tools[0].id);
    expect(tools[0].id).toBeLessThan(turns[1].seq);
  });

  it("the live view says how a tool call went, not only that one ran", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [
      tool("capture_lead", 1, {}, { error: "a name and a reason are both needed; ask the caller for the missing one" }, T(1, 1)),
      tool("end_call", 1, {}, { status: "ending" }, T(1, 2)),
    ]);
    const org = (await db.query("SELECT org_id FROM calls WHERE call_id = $1", [id(1)])).rows[0].org_id;
    const shown = (await Call.shownEvents(org, id(1), 0)).map((e) => e.shown).filter((e) => e.event === "tool");
    expect(shown).toEqual([
      { event: "tool", name: "capture_lead", label: "Save details", outcome: "needs_info" },
      { event: "tool", name: "end_call", label: "End the call", outcome: "worked" },
    ]);
  });
});

describe("rows written before outcomes were kept", () => {
  it("are read once at start-up and filed, safely run again, and redone when the reading changes", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [
      tool("end_call", 1, {}, { error: "the caller has not said goodbye, so do not hang up" }, T(1, 1)),
      { event: "tool_rejected", tool: "get_balance", reason: "x", at: T(1, 2) },
      { event: "tool", name: "capture_lead", at: T(1, 3) }, // what the oldest voice service wrote: nothing to read
    ]);
    await db.query("UPDATE call_events SET outcome = NULL");
    await db.query("DELETE FROM meta WHERE key = 'tool_outcome_version'");
    expect(await backfillToolOutcomes()).toMatchObject({ changed: 3 });
    const outcomes = async () => (await db.query("SELECT outcome FROM call_events WHERE event IN ('tool', 'tool_rejected') ORDER BY id")).rows.map((r) => r.outcome);
    expect(await outcomes()).toEqual(["blocked", "not_attached", "unknown"]);
    expect(await backfillToolOutcomes()).toMatchObject({ changed: 0 }); // nothing left to do

    await db.query("UPDATE call_events SET outcome = 'worked'"); // a reading an older classifier made
    await db.query("UPDATE meta SET value = $1 WHERE key = 'tool_outcome_version'", [String(OUTCOME_VERSION - 1)]);
    expect(await backfillToolOutcomes()).toMatchObject({ changed: 3 });
    expect(await outcomes()).toEqual(["blocked", "not_attached", "unknown"]);
  });

  it("are filtered and counted by the same reading as new ones even before that pass", async () => {
    const b = await owner();
    const a = await setUp(b);
    await aCall(a, 1, [tool("end_call", 1, {}, { status: "ending" }, T(1, 1)), { event: "tool", name: "capture_lead", at: T(1, 2) }]);
    await db.query("UPDATE call_events SET outcome = NULL");
    const page = await history(b);
    expect(page.calls[0].turns.flatMap((t) => t.calls).map((c) => c.outcome)).toEqual(["worked", "unknown"]);
    expect(page.summary).toMatchObject({ worked: 1, unknown: 1 });
  });
});
