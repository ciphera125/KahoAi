import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, owner } from "./helpers.js";
import { promptProblems } from "../src/models/promptCheck.js";
import * as Agent from "../src/models/Agent.js";

beforeEach(freshDb);

const RIA = `# TOOLS
Use these to get facts.
- get_tasks(date_range, status): returns tasks for "today".
- mark_task_done(task_id): marks a task as completed.
Greet {{user_name}} and remind them about {{task_title}}.`;

describe("what a prompt may say about tools (the 2026-11-07 bug)", () => {
  it("names every tool the prompt asks for that the agent does not have", () => {
    const problems = promptProblems(RIA, ["end_call", "capture_lead"]);
    expect(problems.filter((p) => p.code === "unattached_tool").map((p) => p.found))
      .toEqual(["get_tasks", "mark_task_done"]);
    expect(problems[0].message).toContain("get_tasks");
    expect(problems[0].message).toContain("not one of this agent's tools");
  });

  it("names every variable nothing fills in", () => {
    expect(promptProblems(RIA, []).filter((p) => p.code === "unfilled_variable").map((p) => p.found))
      .toEqual(["user_name", "task_title"]);
  });

  it("is happy with a prompt that only uses the tools it has", () => {
    expect(promptProblems("Say goodbye, then use end_call. Save details with capture_lead.",
      ["end_call", "capture_lead"])).toEqual([]);
  });

  it("says nothing about ordinary prose, Hindi or punctuation", () => {
    expect(promptProblems("You are Ria. मैं कर सकती हूँ. Ask one question at a time; be warm.", [])).toEqual([]);
  });

  it("reports a tool once however often the prompt repeats it", () => {
    const problems = promptProblems("call get_tasks, then get_tasks again, then get_tasks", []);
    expect(problems.map((p) => p.found)).toEqual(["get_tasks"]);
  });

  it("tells the user how to fix an unattached tool we do have", () => {
    const [problem] = promptProblems("use transfer_to_human when asked", ["end_call"]);
    expect(problem.message).toContain("Transfer to a person");
    expect(problem.message).toContain("attach");
  });
});

describe("variables the agent can actually fill in", () => {
  it("accepts an answer the agent collects, and still catches one it does not", () => {
    const known = ["answer.payment_date"];
    expect(promptProblems("Remind them about {{answer.payment_date}}.", [], known)).toEqual([]);
    const [problem] = promptProblems("Remind them about {{answer.bank_name}}.", [], known);
    expect(problem).toMatchObject({ code: "unfilled_variable", found: "answer.bank_name" });
  });

  it("a prompt using a question this agent saves can be published", async () => {
    const b = await owner();
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    await b.patch(`/api/agents/${a.id}`).send({ settings: { capture_fields: [{ label: "Payment date", kind: "date" }] } });
    const saved = await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: "Confirm {{answer.payment_date}} with them." });
    expect(saved.body.warnings).toEqual([]);
    expect((await b.post(`/api/agents/${a.id}/publish`).send({})).status).toBe(200);
  });
});

describe("a prompt that calls for tools the agent lacks never reaches a call", () => {
  const save = (b, id, text) => b.patch(`/api/prompts/${id}`).send({ text });

  it("saves as a draft with a warning, and refuses to publish it", async () => {
    // Since migration 009 a save is a draft, so it is Publish that refuses. What must
    // never happen is the prompt reaching a call, and it does not.
    const b = await owner();
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    const r = await save(b, a.active_prompt_id, RIA);
    expect(r.status).toBe(200);
    expect(r.body.warnings.map((w) => w.found)).toContain("get_tasks");

    const published = await b.post(`/api/agents/${a.id}/publish`).send({});
    expect(published.status).toBe(400);
    expect(published.body.error).toContain("get_tasks");
    expect((await Agent.callConfig(a.id)).prompt).toBe("You are Ria.");
  });

  it("takes the same prompt once the tool is attached", async () => {
    const b = await owner();
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call", "transfer_to_human"] });
    const r = await save(b, a.active_prompt_id, "Use transfer_to_human when they ask for a person.");
    expect(r.status).toBe(200);
    expect(r.body.prompt).toContain("transfer_to_human");
  });

  it("refuses a new agent whose first prompt asks for a tool it will not have", async () => {
    const b = await owner();
    const r = await b.post("/api/agents").send({ name: "Ria", prompt: RIA });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("get_tasks");
    expect((await b.get("/api/agents")).body).toEqual([]);
  });

  it("warns when a tool is taken away while the prompt still asks for it, and will not publish that", async () => {
    const b = await owner();
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "Use capture_lead for details." })).body;
    const r = await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call"] });
    expect(r.status).toBe(200);
    expect(r.body.warnings.map((w) => w.found)).toEqual(["capture_lead"]);

    const published = await b.post(`/api/agents/${a.id}/publish`).send({});
    expect(published.status).toBe(400);
    expect(published.body.error).toContain("capture_lead");
    expect((await Agent.callConfig(a.id)).tools).toEqual(["end_call", "capture_lead"]);
  });
});
