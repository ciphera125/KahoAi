import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, internal, member, owner, db } from "./helpers.js";

beforeEach(freshDb);

const newAgent = (b, body = {}) => b.post("/api/agents").send({ name: "EMI reminder",
  description: "Reminds borrowers", prompt: "You are Riya from Acme.", ...body });

describe("agents", () => {
  it("gives a new agent its own prompt, in use, and the default tools and settings", async () => {
    const b = await owner();
    const r = await newAgent(b);
    expect(r.status).toBe(200);
    const a = r.body;
    expect(a.id).toMatch(/^ag_[0-9a-f]{12}$/);
    expect(a).toMatchObject({ name: "EMI reminder", description: "Reminds borrowers",
      tools: ["end_call", "capture_lead"], settings: { opening_line: "", max_minutes: 10, ring_secs: 40 }, numbers: [] });
    expect(a.prompt_ids).toEqual([a.active_prompt_id]);
    const p = (await b.get(`/api/prompts/${a.active_prompt_id}`)).body;
    expect(p).toMatchObject({ name: "EMI reminder prompt", agent_id: a.id, agent_name: "EMI reminder",
      in_use: true, prompt: "You are Riya from Acme.", version_count: 1 });
  });

  it("refuses bad agents in plain words", async () => {
    const b = await owner();
    expect((await newAgent(b, { name: "  " })).body.error).toBe("the agent name is empty");
    expect((await newAgent(b, { name: "x".repeat(61) })).body.error).toBe("the agent name is over 60 characters");
    expect((await newAgent(b, { prompt: "" })).body.error).toBe("the prompt is empty");
    expect((await newAgent(b, { prompt: "x".repeat(8001) })).body.error).toBe("the prompt is over 8000 characters");
  });

  it("lists agents with their call counts, and edits tools, settings and details", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await internal("put", "/internal/v1/calls/call-0001").send({ status: "answered", agent_id: a.id, at: new Date().toISOString() });
    const list = (await b.get("/api/agents")).body;
    expect(list).toHaveLength(1);
    expect(list[0].call_count).toBe(1);
    const tools = await b.patch(`/api/agents/${a.id}`).send({ tools: ["transfer_to_human", "end_call"] });
    expect(tools.body.tools).toEqual(["end_call", "transfer_to_human"]);
    const bad = await b.patch(`/api/agents/${a.id}`).send({ tools: ["rm_rf"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("tools must be from: end_call, capture_lead, transfer_to_human, call_webhook");
    const s = await b.patch(`/api/agents/${a.id}`).send({ settings: { opening_line: " Hi  there ", max_minutes: "5", ring_secs: 20 } });
    expect(s.body.settings).toMatchObject({ opening_line: "Hi there", max_minutes: 5, ring_secs: 20 });
    expect(s.body.settings.call_window).toEqual({ enabled: false, start: "09:00", end: "21:00", timezone: "Asia/Kolkata" });
    for (const [settings, error] of [
      [{ max_minutes: 0 }, "Longest call (minutes) must be between 1 and 30"],
      [{ ring_secs: 61 }, "Ring for (seconds) must be between 15 and 60"],
      [{ ring_secs: true }, "Ring for (seconds) must be a number"],
      [{ colour: "red" }, "unknown setting 'colour'"],
    ]) {
      const r = await b.patch(`/api/agents/${a.id}`).send({ settings });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(error);
    }
    const d = await b.patch(`/api/agents/${a.id}`).send({ name: "Renamed", description: "" });
    expect(d.body).toMatchObject({ name: "Renamed", description: "" });
    expect((await b.get("/api/agents/ag_000000000000")).status).toBe(404);
    expect((await b.get("/api/agents/../../etc/passwd")).status).toBe(404);
  });

  it("will not let an agent ask for a longer call than the server allows", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    expect((await b.get("/api/config")).body.limits).toEqual({ max_minutes: 10, ring_secs: [15, 60] });
    const r = await b.patch(`/api/agents/${a.id}`).send({ settings: { max_minutes: 11 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Longest call can be at most 10 minutes on this server (MAX_CALL_DURATION_SECS)");
  });

  it("deletes an agent (owner only), keeping its prompts unassigned and dropping its numbers", async () => {
    const o = await owner();
    const a = (await newAgent(o)).body;
    await db.query("INSERT INTO routes (number, agent_id, org_id) SELECT '+918065520552', id, org_id FROM agents WHERE id = $1", [a.id]);
    const m = await member(o);
    expect((await m.delete(`/api/agents/${a.id}`)).status).toBe(403);
    expect((await o.delete(`/api/agents/${a.id}`)).body).toEqual({ deleted: a.id });
    const prompts = (await o.get("/api/prompts")).body;
    expect(prompts[0]).toMatchObject({ agent_id: null, in_use: false });
    expect((await db.query("SELECT * FROM routes")).rowCount).toBe(0);
    expect((await o.delete(`/api/agents/${a.id}`)).status).toBe(404);
  });
});

describe("prompts", () => {
  it("keeps every edit as a version, skips an unchanged save, restores and deletes versions", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    const pid = a.active_prompt_id;
    const same = await b.patch(`/api/prompts/${pid}`).send({ text: "You are Riya from Acme." });
    expect(same.body.version_count).toBe(1);
    await b.patch(`/api/prompts/${pid}`).send({ text: "Version two" });
    const renamed = await b.patch(`/api/prompts/${pid}`).send({ name: "Main" });
    expect(renamed.body).toMatchObject({ name: "Main", prompt: "Version two", version_count: 2 });
    const versions = (await b.get(`/api/prompts/${pid}/versions`)).body;
    expect(versions.map((v) => v.prompt)).toEqual(["Version two", "You are Riya from Acme."]);
    const current = await b.delete(`/api/prompts/${pid}/versions/${versions[0].id}`);
    expect(current.status).toBe(400);
    expect(current.body.error).toBe("this is the version in use; restore another one first");
    const restored = await b.post(`/api/prompts/${pid}/versions/${versions[1].id}/restore`);
    expect(restored.body).toMatchObject({ prompt: "You are Riya from Acme.", version_count: 3 });
    expect((await b.delete(`/api/prompts/${pid}/versions/${versions[0].id}`)).body).toEqual({ deleted: versions[0].id });
    expect((await b.get(`/api/prompts/${pid}/versions`)).body).toHaveLength(2);
    expect((await b.post(`/api/prompts/${pid}/versions/v_nope/restore`)).status).toBe(404);
  });

  it("keeps at most 50 versions", async () => {
    const b = await owner();
    const pid = (await newAgent(b)).body.active_prompt_id;
    for (let i = 0; i < 55; i++) await b.patch(`/api/prompts/${pid}`).send({ text: `v${i}` });
    const versions = (await b.get(`/api/prompts/${pid}/versions`)).body;
    expect(versions).toHaveLength(50);
    expect(versions[0].prompt).toBe("v54");
  });

  it("moves a prompt between agents and fixes which prompt each one uses", async () => {
    const b = await owner();
    const one = (await newAgent(b, { name: "One" })).body;
    const two = (await newAgent(b, { name: "Two" })).body;
    const extra = (await b.post("/api/prompts").send({ name: "Extra", prompt: "Hello", agent_id: one.id })).body;
    expect(extra).toMatchObject({ agent_id: one.id, in_use: false });
    const moved = (await b.post(`/api/prompts/${one.active_prompt_id}/assign`).send({ agent_id: two.id })).body;
    expect(moved).toMatchObject({ agent_id: two.id, agent_name: "Two", in_use: false });
    expect((await b.get(`/api/agents/${one.id}`)).body.active_prompt_id).toBe(extra.id);
    expect((await b.get(`/api/agents/${two.id}`)).body.active_prompt_id).toBe(two.active_prompt_id);
    const use = await b.patch(`/api/agents/${two.id}`).send({ active_prompt_id: moved.id });
    expect(use.body.active_prompt_id).toBe(moved.id);
    const foreign = await b.patch(`/api/agents/${two.id}`).send({ active_prompt_id: extra.id });
    expect(foreign.body.error).toBe("the prompt in use must be one of this agent's prompts");
    expect((await b.post("/api/prompts").send({ name: "X", prompt: "y", agent_id: "ag_000000000000" })).status).toBe(404);
  });

  it("deleting the prompt in use falls back to another of the agent's (owner only)", async () => {
    const o = await owner();
    const a = (await newAgent(o)).body;
    const other = (await o.post("/api/prompts").send({ name: "Other", prompt: "Hi", agent_id: a.id })).body;
    const m = await member(o);
    expect((await m.delete(`/api/prompts/${a.active_prompt_id}`)).status).toBe(403);
    expect((await o.delete(`/api/prompts/${a.active_prompt_id}`)).status).toBe(200);
    expect((await o.get(`/api/agents/${a.id}`)).body.active_prompt_id).toBe(other.id);
    await o.delete(`/api/prompts/${other.id}`);
    expect((await o.get(`/api/agents/${a.id}`)).body.active_prompt_id).toBeNull();
  });

  it("lists prompts newest first with their agent and version count", async () => {
    const b = await owner();
    await newAgent(b, { name: "First" });
    await b.post("/api/prompts").send({ name: "Loose", prompt: "Hi" });
    const list = (await b.get("/api/prompts")).body;
    expect(list.map((p) => p.name)).toEqual(["Loose", "First prompt"]);
    expect(list[0]).toMatchObject({ agent_id: null, agent_name: null, in_use: false, version_count: 1 });
  });
});

describe("what a call reads (internal API)", () => {
  it("gives the voice service an agent's prompt, tools and limits", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/agents/${a.id}`).send({ settings: { opening_line: "Namaste", max_minutes: 3, ring_secs: 25 } });
    const r = await internal("get", `/internal/v1/call-config?agent_id=${a.id}`);
    expect(r.body.config).toMatchObject({ agent_id: a.id, name: "EMI reminder", prompt: "You are Riya from Acme.",
      tools: ["end_call", "capture_lead"], opening_line: "Namaste", max_secs: 180, ring_secs: 25 });
    expect(r.body.config.org_id).toMatch(/^org_/);
    expect(r.body.config.call_window).toMatchObject({ enabled: false });
  });

  it("answers null, never an error, for an unknown or hostile agent id", async () => {
    for (const id of ["ag_000000000000", "nope", "'; DROP TABLE agents; --", ""]) {
      const r = await internal("get", `/internal/v1/call-config?agent_id=${encodeURIComponent(id)}`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ config: null });
    }
  });

  it("routes a number to its agent", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await db.query("INSERT INTO routes (number, agent_id, org_id) SELECT '+918065520552', id, org_id FROM agents WHERE id = $1", [a.id]);
    const r = await internal("get", "/internal/v1/call-config?number=08065520552");
    expect(r.body.config.agent_id).toBe(a.id);
    expect((await internal("get", "/internal/v1/call-config?number=junk")).body).toEqual({ config: null });
  });
});
