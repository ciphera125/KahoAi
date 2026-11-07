import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, internal, line, owner, publish, OURS } from "./helpers.js";

beforeEach(freshDb);

const CALL = "77777777-7777-7777-7777-777777777777";
const T = (s) => `2026-11-08T10:00:${String(s).padStart(2, "0")}.000Z`;

async function aCallWithTools(b) {
  await line(b);
  await b.post("/api/contacts").send({ name: "Ravi", numbers: ["+919876543210"] });
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  await publish(b, a.id).catch(() => {});
  await internal("put", `/internal/v1/calls/${CALL}`)
    .send({ status: "answered", peer: "+919876543210", ours: OURS, agent_id: a.id, agent_version: 1 });
  await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
    { event: "call_start", at: T(0) },
    { event: "turn", role: "user", text: "When is my EMI due?", at: T(1) },
    { event: "tool", name: "get_tasks", turn: 1, ok: true, seconds: 0.42,
      text: '{"args":{"range":"today"},"result":{"count":1}}', at: T(2) },
    { event: "turn", role: "user", text: "Move it to Friday", at: T(3) },
    { event: "tool", name: "reschedule_task", turn: 2, ok: false, seconds: 1.2,
      text: '{"args":{"task_id":"tk_1"},"result":{"what_to_do":"I could not find that task."}}', at: T(4) },
    { event: "tool_rejected", tool: "get_balance", reason: "Tool call validation failed", at: T(5) },
    { event: "call_end", at: T(6) },
  ] });
  return a;
}

describe("the history of what the tools did", () => {
  it("groups a call's tool calls by the turn they happened on", async () => {
    const b = await owner();
    await aCallWithTools(b);
    const r = await b.get("/api/calls/tools");
    expect(r.status).toBe(200);
    const [call] = r.body.calls;
    expect(call).toMatchObject({ call_id: CALL, contact_name: "Ravi", agent_name: "Ria", agent_version: 1 });
    expect(call.turns.map((t) => t.turn)).toEqual([1, 2, null]);
    expect(call.turns[0].calls[0]).toMatchObject({ tool: "get_tasks", label: "Read out their tasks",
      status: "worked", secs: 0.42 });
    expect(call.turns[0].said).toBe("When is my EMI due?");
  });

  it("says plainly what went wrong, and what the agent did instead", async () => {
    const b = await owner();
    await aCallWithTools(b);
    const [call] = (await b.get("/api/calls/tools")).body.calls;
    const failed = call.turns[1].calls[0];
    expect(failed).toMatchObject({ tool: "reschedule_task", status: "failed" });
    expect(failed.why).toBe("I could not find that task.");

    const refused = call.turns[2].calls[0];
    expect(refused).toMatchObject({ tool: "get_balance", status: "refused" });
    expect(refused.why).toMatch(/not one of this agent's tools|refused/i);
  });

  it("keeps the technical detail apart from the plain summary", async () => {
    const b = await owner();
    await aCallWithTools(b);
    const [call] = (await b.get("/api/calls/tools")).body.calls;
    const first = call.turns[0].calls[0];
    expect(first.sent).toEqual({ range: "today" });
    expect(first.answer).toEqual({ count: 1 });
  });

  it("filters by tool, by status and by agent", async () => {
    const b = await owner();
    const agent = await aCallWithTools(b);
    expect((await b.get("/api/calls/tools?tool=get_tasks")).body.calls[0].turns).toHaveLength(1);
    expect((await b.get("/api/calls/tools?status=failed")).body.calls[0].turns
      .flatMap((t) => t.calls).every((c) => c.status !== "worked")).toBe(true);
    expect((await b.get(`/api/calls/tools?agent_id=${agent.id}`)).body.calls).toHaveLength(1);
    expect((await b.get("/api/calls/tools?agent_id=ag_000000000000")).body.calls).toEqual([]);
  });

  it("filters by day and by contact", async () => {
    const b = await owner();
    await aCallWithTools(b);
    expect((await b.get("/api/calls/tools?from=2026-11-08&to=2026-11-09")).body.calls).toHaveLength(1);
    expect((await b.get("/api/calls/tools?from=2026-11-01&to=2026-11-02")).body.calls).toEqual([]);
    expect((await b.get("/api/calls/tools?contact=Ravi")).body.calls).toHaveLength(1);
    expect((await b.get("/api/calls/tools?contact=Nobody")).body.calls).toEqual([]);
  });

  it("is never another organization's", async () => {
    const b = await owner();
    await aCallWithTools(b);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect((await other.get("/api/calls/tools")).body.calls).toEqual([]);
  });

  it("records which version of the agent answered the call", async () => {
    const b = await owner();
    await aCallWithTools(b);
    const [call] = (await b.get("/api/calls/tools")).body.calls;
    expect(call.agent_version).toBe(1);
  });

  it("takes the version from the call's own start, not from the hangup report", async () => {
    // The hangup webhook is a separate request from Plivo and knows nothing about which
    // version answered, so the voice service says so when the call starts.
    const b = await owner();
    await line(b);
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "Hi" })).body;
    await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", ours: OURS, agent_id: a.id });
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
      { event: "call_agent", agent_id: a.id, version: 4, at: T(0) },
      { event: "tool", name: "end_call", turn: 1, ok: true, seconds: 0.1, text: "{}", at: T(1) },
    ] });
    const [call] = (await b.get("/api/calls/tools")).body.calls;
    expect(call.agent_version).toBe(4);
  });
});
