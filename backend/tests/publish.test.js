import { beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, member, owner } from "./helpers.js";
import * as Agent from "../src/models/Agent.js";

beforeEach(freshDb);

const newAgent = (b, body = {}) => b.post("/api/agents").send({ name: "Ria",
  description: "Task reminders", prompt: "You are Ria from Kaho AI.", ...body });

/** What a call would actually be given right now. */
const live = (agentId) => Agent.callConfig(agentId);

describe("a new agent is live straight away", () => {
  it("is published as version 1 when it is created", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    expect(a.live_version).toMatchObject({ number: 1 });
    expect(a.draft_changed).toBe(false);
    expect((await live(a.id)).prompt).toBe("You are Ria from Kaho AI.");
  });
});

describe("saving is a draft; publishing is what a caller hears", () => {
  it("a saved prompt does not reach a call until it is published", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: "You are Ria. Speak Hindi." });

    expect((await live(a.id)).prompt).toBe("You are Ria from Kaho AI.");
    expect((await b.get(`/api/agents/${a.id}`)).body.draft_changed).toBe(true);

    const published = await b.post(`/api/agents/${a.id}/publish`).send({});
    expect(published.status).toBe(200);
    expect(published.body.live_version).toMatchObject({ number: 2 });
    expect((await live(a.id)).prompt).toBe("You are Ria. Speak Hindi.");
    expect((await b.get(`/api/agents/${a.id}`)).body.draft_changed).toBe(false);
  });

  it("changed tools and settings are a draft too", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call"], settings: { max_minutes: 3 } });

    expect((await live(a.id)).tools).toEqual(["end_call", "capture_lead"]);
    expect((await live(a.id)).max_secs).toBe(600);

    await b.post(`/api/agents/${a.id}/publish`).send({});
    expect((await live(a.id)).tools).toEqual(["end_call"]);
    expect((await live(a.id)).max_secs).toBe(180);
  });

  it("publishing nothing new is refused, so the history stays meaningful", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    const r = await b.post(`/api/agents/${a.id}/publish`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/nothing/i);
  });
});

describe("a prompt that asks for a tool the agent lacks: warn on save, block on publish", () => {
  const BAD = "Use get_tasks when they ask what is due.";

  it("saves the draft and says what is wrong, without blocking", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    const r = await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: BAD });
    expect(r.status).toBe(200);
    expect(r.body.prompt).toBe(BAD);
    expect(r.body.warnings.map((w) => w.found)).toEqual(["get_tasks"]);
  });

  it("refuses to publish it, naming the tool", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: BAD });
    const r = await b.post(`/api/agents/${a.id}/publish`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("get_tasks");
    expect((await live(a.id)).prompt).toBe("You are Ria from Kaho AI.");
  });

  it("lists every problem on its own, for the page to show", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: "use get_tasks, greet {{user_name}}" });
    const r = await b.get(`/api/agents/${a.id}/check`);
    expect(r.status).toBe(200);
    expect(r.body.problems.map((p) => p.code)).toEqual(["unattached_tool", "unfilled_variable"]);
    expect(r.body.can_publish).toBe(false);
  });

  it("an admin may publish anyway, and the override is kept with who and what", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: BAD });
    const r = await b.post(`/api/agents/${a.id}/publish`).send({ override: true });
    expect(r.status).toBe(200);
    expect((await live(a.id)).prompt).toBe(BAD);

    const { rows } = await db.query(
      "SELECT published_by_name, overrides FROM agent_versions WHERE agent_id = $1 ORDER BY number DESC LIMIT 1", [a.id]);
    expect(rows[0].published_by_name).toBe("Asha Rao");
    expect(rows[0].overrides.map((o) => o.found)).toEqual(["get_tasks"]);
  });

  it("someone who is not an admin cannot override", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: BAD });
    const m = await member(b);
    const r = await m.post(`/api/agents/${a.id}/publish`).send({ override: true });
    expect(r.status).toBe(403);
    expect((await live(a.id)).prompt).toBe("You are Ria from Kaho AI.");
  });
});

describe("version history and rollback", () => {
  it("records who published each version and when", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: "Second." });
    await b.post(`/api/agents/${a.id}/publish`).send({ note: "Hindi opening" });

    const r = await b.get(`/api/agents/${a.id}/versions`);
    expect(r.status).toBe(200);
    expect(r.body.map((v) => v.number)).toEqual([2, 1]);
    expect(r.body[0]).toMatchObject({ published_by_name: "Asha Rao", note: "Hindi opening", live: true });
    expect(r.body[0].published_at).toMatch(/^\d{4}-/);
    expect(r.body[1].live).toBe(false);
  });

  it("rolling back puts an old version live again, as a new version", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: "Second, and worse." });
    await b.post(`/api/agents/${a.id}/publish`).send({});
    const [, first] = (await b.get(`/api/agents/${a.id}/versions`)).body;

    const r = await b.post(`/api/agents/${a.id}/versions/${first.id}/restore`).send({});
    expect(r.status).toBe(200);
    expect((await live(a.id)).prompt).toBe("You are Ria from Kaho AI.");

    const versions = (await b.get(`/api/agents/${a.id}/versions`)).body;
    expect(versions.map((v) => v.number)).toEqual([3, 2, 1]);
    expect(versions[0].note).toContain("version 1");
    // The draft follows it back, so the page does not show a change nobody made.
    expect((await b.get(`/api/agents/${a.id}`)).body.draft_changed).toBe(false);
  });

  it("will not restore another organization's version", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    const theirs = (await newAgent(other)).body;
    const [v1] = (await other.get(`/api/agents/${theirs.id}/versions`)).body;
    const r = await b.post(`/api/agents/${a.id}/versions/${v1.id}/restore`).send({});
    expect(r.status).toBe(404);
  });
});

describe("a call keeps the version it started with", () => {
  it("publishing mid-call does not change what that call was given", async () => {
    const b = await owner();
    const a = (await newAgent(b)).body;
    const answered = await live(a.id); // what /answer read when the call came in

    await b.patch(`/api/prompts/${a.active_prompt_id}`).send({ text: "Changed mid-call." });
    await b.post(`/api/agents/${a.id}/publish`).send({});

    expect(answered.prompt).toBe("You are Ria from Kaho AI.");
    expect(answered.version).toBe(1);
    expect((await live(a.id)).version).toBe(2);
  });
});
