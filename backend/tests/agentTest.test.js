import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, member, owner, publish } from "./helpers.js";
import { config } from "../src/config/env.js";
import * as AgentTest from "../src/models/AgentTest.js";
import * as Agent from "../src/models/Agent.js";

beforeEach(freshDb);
afterEach(() => { AgentTest.useModel(null); config.REQUIRE_AGENT_TEST = false; });

// A stand-in for the model. It answers in words unless the script says otherwise.
const say = (content) => ({ message: { content } });
const call = (name, args = {}) => ({ message: { content: null, tool_calls: [{ id: `c_${name}`,
  function: { name, arguments: JSON.stringify(args) } }] } });
const refusal = (tool) => Object.assign(new Error(`Tool call validation failed: parameters for tool ${tool} did not match schema`),
  { status: 400, code: "tool_use_failed" });

/** Replies come from `script`, one per model call, in order; the last one repeats. */
function scripted(...script) {
  const calls = [];
  AgentTest.useModel(async (request) => {
    calls.push(request);
    const next = script.length > 1 ? script.shift() : script[0];
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(request) : next;
  });
  return calls;
}

const newAgent = (b, body = {}) => b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria.", ...body });
const test = (b, id, body = {}) => b.post(`/api/agents/${id}/test`).send(body);

describe("testing an agent's draft", () => {
  it("talks to the draft, not to what is live", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: "You are Ria. Draft only." });
    const calls = scripted(say("Hello, this is Ria."));
    await test(b, a.id);
    expect(calls[0].messages[0].content).toContain("Draft only.");
  });

  it("is offered only the tools the draft has, with the schemas a real call uses", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call", "add_task"] });
    const calls = scripted(say("Hi."));
    await test(b, a.id);
    expect(calls[0].tools.map((t) => t.function.name)).toEqual(["end_call", "add_task"]);
    expect(calls[0].tools[1].function.parameters.required).toEqual(["title"]);
  });

  it("passes when every turn is answered in words and no tool is refused", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    scripted(say("Hello, this is Ria."));
    const r = await test(b, a.id);
    expect(r.status).toBe(200);
    expect(r.body.passed).toBe(true);
    expect(r.body.turns.length).toBeGreaterThanOrEqual(3);
    expect(r.body.turns[0]).toMatchObject({ said: expect.any(String), reply: "Hello, this is Ria." });
  });

  it("runs the lines it is given instead of the default ones", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    const calls = scripted(say("Of course."));
    const r = await test(b, a.id, { messages: ["Where is my order?"] });
    expect(r.body.turns).toHaveLength(1);
    expect(calls[0].messages.at(-1)).toEqual({ role: "user", content: "Where is my order?" });
  });

  it("shows the tools it used, with what it sent, and does not really do them", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call", "add_task"] });
    scripted(call("add_task", { title: "Pay EMI", due: "next Friday" }), say("Done, I have added it."));
    const r = await test(b, a.id, { messages: ["Add a task to pay my EMI"] });
    expect(r.body.passed).toBe(true);
    const used = r.body.turns[0].tools[0];
    expect(used).toMatchObject({ tool: "add_task", status: "worked", dry_run: true });
    expect(used.sent).toEqual({ title: "Pay EMI", due: "next Friday" });
    expect((await db.query("SELECT 1 FROM tasks")).rowCount).toBe(0);
  });

  it("fails, and says which tool, when the model asks for one it was not given", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    scripted(refusal("get_tasks"), say("Sorry, I cannot check that."));
    const r = await test(b, a.id, { messages: ["What is due today?"] });
    expect(r.body.passed).toBe(false);
    expect(r.body.note).toContain("get_tasks");
    expect(r.body.turns[0].tools[0]).toMatchObject({ tool: "get_tasks", status: "refused" });
    // The turn was still answered in words, as it would be on a call.
    expect(r.body.turns[0].reply).toBe("Sorry, I cannot check that.");
  });

  it("answers a refused turn without tools, with the same line a real call sends", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    const calls = scripted(refusal("get_tasks"), say("Sorry."));
    await test(b, a.id, { messages: ["What is due?"] });
    expect(calls[1].tools).toBeUndefined();
    expect(calls[1].messages.at(-1)).toEqual({ role: "system", content: "Answer in words only; do not call any tool." });
  });

  it("fails when the agent says nothing at all", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    scripted(say(""));
    const r = await test(b, a.id, { messages: ["Hello"] });
    expect(r.body.passed).toBe(false);
    expect(r.body.note).toMatch(/said nothing/i);
  });

  it("says plainly when it cannot reach the model, and does not count that as a pass", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    AgentTest.useModel(async () => { throw new Error("connect ECONNREFUSED"); });
    const r = await test(b, a.id, { messages: ["Hello"] });
    expect(r.status).toBe(200);
    expect(r.body.passed).toBe(false);
    expect(r.body.note).toMatch(/could not reach/i);
    expect(r.body.note).not.toContain("ECONNREFUSED");
  });

  it("says it is not set up, rather than failing mysteriously, when there is no model", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    AgentTest.useModel(null);
    const saved = config.GROQ_API_KEY;
    config.GROQ_API_KEY = "";
    try {
      const r = await test(b, a.id);
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/GROQ_API_KEY/);
    } finally { config.GROQ_API_KEY = saved; }
  });

  it("limits what it will run, so it cannot be used to burn tokens", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    scripted(say("Ok."));
    const many = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    expect((await test(b, a.id, { messages: many })).status).toBe(400);
    expect((await test(b, a.id, { messages: ["x".repeat(600)] })).status).toBe(400);
  });

  it("is only ever of this organization's agent", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    scripted(say("Hi."));
    expect((await test(other, a.id)).status).toBe(404);
  });
});

describe("what Publish asks of a test", () => {
  const gate = () => { config.REQUIRE_AGENT_TEST = true; };

  async function draftChanged(b) {
    const a = (await newAgent(b)).body;
    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: "You are Ria. A new draft." });
    return a;
  }

  it("will not publish a draft that has not been tested", async () => {
    const b = await owner();
    const a = await draftChanged(b);
    gate();
    const r = await b.post(`/api/agents/${a.id}/publish`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/test/i);
    expect((await Agent.callConfig(a.id)).prompt).toBe("You are Ria.");
  });

  it("publishes once the same draft has passed", async () => {
    const b = await owner();
    const a = await draftChanged(b);
    scripted(say("Hello."));
    gate();
    expect((await test(b, a.id)).body.passed).toBe(true);
    expect((await b.post(`/api/agents/${a.id}/publish`).send({})).status).toBe(200);
    expect((await Agent.callConfig(a.id)).prompt).toBe("You are Ria. A new draft.");
  });

  it("a pass does not carry over to a draft that has changed since", async () => {
    const b = await owner();
    const a = await draftChanged(b);
    scripted(say("Hello."));
    gate();
    await test(b, a.id);
    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: "You are Ria. Changed again." });
    const r = await b.post(`/api/agents/${a.id}/publish`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/changed since/i);
  });

  it("will not publish after a failed test", async () => {
    const b = await owner();
    const a = await draftChanged(b);
    scripted(say(""));
    gate();
    expect((await test(b, a.id)).body.passed).toBe(false);
    const r = await b.post(`/api/agents/${a.id}/publish`).send({});
    expect(r.status).toBe(400);
  });

  it("an admin can publish an untested draft, and it is kept on the version", async () => {
    const b = await owner();
    const a = await draftChanged(b);
    gate();
    const r = await b.post(`/api/agents/${a.id}/publish`).send({ override: true });
    expect(r.status).toBe(200);
    const { rows } = await db.query("SELECT overrides FROM agent_versions WHERE agent_id = $1 ORDER BY number DESC LIMIT 1", [a.id]);
    expect(rows[0].overrides.map((o) => o.code)).toContain("untested");
  });

  it("someone who is not an admin cannot override it", async () => {
    const b = await owner();
    const a = await draftChanged(b);
    const m = await member(b);
    gate();
    expect((await m.post(`/api/agents/${a.id}/publish`).send({ override: true })).status).toBe(403);
  });

  it("tells the page where the test stands, so it can show the button", async () => {
    const b = await owner();
    const a = await draftChanged(b);
    gate();
    let check = (await b.get(`/api/agents/${a.id}/check`)).body;
    expect(check.test).toMatchObject({ status: "none" });
    expect(check.can_publish).toBe(false);

    scripted(say("Hello."));
    await test(b, a.id);
    check = (await b.get(`/api/agents/${a.id}/check`)).body;
    expect(check.test).toMatchObject({ status: "passed" });
    expect(check.can_publish).toBe(true);
  });

  it("leaves everything else alone when the gate is switched off", async () => {
    const b = await owner();
    const a = await draftChanged(b);
    config.REQUIRE_AGENT_TEST = false;
    expect((await publish(b, a.id)).live_version.number).toBe(2);
  });
});
