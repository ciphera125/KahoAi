import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, member, owner } from "./helpers.js";
import { useModel } from "../src/models/llm.js";

beforeEach(freshDb);
afterEach(() => useModel(null));

const say = (content) => ({ message: { content } });
const propose = (args) => ({ message: { content: null, tool_calls: [{ id: "c1", function: { name: "propose", arguments: JSON.stringify(args) } }] } });
const script = (...answers) => useModel(async () => (answers.length > 1 ? answers.shift() : answers[0]));
const newAgent = async (b) => (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
const talk = (b, body) => b.post("/api/assistant/message").send(body);
const said = (text) => [{ role: "user", content: text }];
const SALON = { kind: "write_down", summary: "The agent will ask for the preferred stylist and write it down.",
  fields: [{ label: "Preferred stylist", kind: "text", ask: "Which stylist would you like?" }] };

describe("Kaho Builder keeps a history of what was asked", () => {
  it("records each prompt with what came of it, newest first", async () => {
    const b = await owner();
    const a = await newAgent(b);
    script(say("Which service is the booking for?"));
    await talk(b, { agent_id: a.id, messages: said("book appointments for my salon") });
    script(propose(SALON));
    await talk(b, { agent_id: a.id, messages: said("ask which stylist they want") });
    const h = (await b.get("/api/assistant/history")).body;
    expect(h.entries.map((e) => e.prompt)).toEqual(["ask which stylist they want", "book appointments for my salon"]);
    expect(h.entries[0]).toMatchObject({ outcome: "built", kind: "write_down", names: ["Preferred stylist"], agent_id: a.id,
      reply: expect.stringMatching(/stylist/), actor: "Asha Rao" });
    expect(h.entries[1]).toMatchObject({ outcome: "asked", kind: null, names: [] });
  });

  it("records a failure honestly, and a prompt the model could not use", async () => {
    const b = await owner();
    const a = await newAgent(b);
    useModel(async () => { throw new Error("boom"); });
    await talk(b, { agent_id: a.id, messages: said("do something") });
    expect((await b.get("/api/assistant/history")).body.entries[0]).toMatchObject({ prompt: "do something", outcome: "failed" });
  });

  it("records only what the person typed last, not the whole conversation again", async () => {
    const b = await owner();
    const a = await newAgent(b);
    script(say("Okay?"));
    await talk(b, { agent_id: a.id, messages: [{ role: "user", content: "first" }, { role: "assistant", content: "q?" }, { role: "user", content: "second" }] });
    const h = (await b.get("/api/assistant/history")).body;
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0].prompt).toBe("second");
  });

  it("can be edited: the edited prompt is a new entry that points at the one it came from", async () => {
    const b = await owner();
    const a = await newAgent(b);
    script(say("Okay?"));
    await talk(b, { agent_id: a.id, messages: said("ask for their phone nubmer") });
    const first = (await b.get("/api/assistant/history")).body.entries[0];
    await talk(b, { agent_id: a.id, edited_from: first.id, messages: said("ask for their phone number") });
    const h = (await b.get("/api/assistant/history")).body.entries;
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ prompt: "ask for their phone number", edited_from: first.id });
    expect(h[1].prompt).toBe("ask for their phone nubmer"); // what was originally asked is never rewritten
  });

  it("refuses an edit that points at someone else's history or at nothing", async () => {
    const b = await owner();
    const a = await newAgent(b);
    script(say("Okay?"));
    await talk(b, { agent_id: a.id, messages: said("mine") });
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    const theirs = (await other.get("/api/assistant/history")).body.entries;
    expect(theirs).toEqual([]);
    const mine = (await b.get("/api/assistant/history")).body.entries[0];
    const r = await talk(other, { edited_from: mine.id, messages: said("x") });
    expect(r.status).toBe(404);
    expect((await talk(b, { edited_from: "abc", messages: said("x") })).status).toBe(400);
  });

  it("can be filtered to one agent and paged", async () => {
    const b = await owner();
    const a1 = await newAgent(b);
    const a2 = (await b.post("/api/agents").send({ name: "Sam", prompt: "You are Sam." })).body;
    script(say("ok"));
    for (let i = 0; i < 12; i++) await talk(b, { agent_id: i % 2 ? a1.id : a2.id, messages: said(`p${i}`) });
    const mine = (await b.get(`/api/assistant/history?agent_id=${a1.id}&per_page=25`)).body;
    expect(mine.total).toBe(6);
    const p = (await b.get("/api/assistant/history?per_page=10")).body;
    expect(p.entries).toHaveLength(10);
    expect(p.total).toBe(12);
    expect((await b.get("/api/assistant/history?per_page=7")).status).toBe(400);
    expect((await b.get("/api/assistant/history?q=p11")).body.entries).toHaveLength(1);
  });

  it("is for people who build; a viewer cannot read it, and no one reads another organization's", async () => {
    const b = await owner();
    const a = await newAgent(b);
    script(say("ok"));
    await talk(b, { agent_id: a.id, messages: said("secret plan: ask for PAN") });
    const v = await member(b, { email: "v@acme.in", name: "V" });
    expect((await v.get("/api/assistant/history")).status).toBe(403);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect(JSON.stringify((await other.get("/api/assistant/history")).body)).not.toMatch(/secret plan/);
  });

  it("can never be changed or erased by the application", async () => {
    const b = await owner();
    script(say("ok"));
    await talk(b, { messages: said("hello") });
    const org = (await db.query("SELECT id FROM organizations LIMIT 1")).rows[0].id;
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE kaho_app");
      await c.query("SELECT set_config('app.org_id', $1, true)", [org]);
      await expect(c.query("UPDATE builder_history SET prompt = 'x'")).rejects.toThrow(/permission denied/);
      await c.query("ROLLBACK");
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE kaho_app");
      await expect(c.query("DELETE FROM builder_history")).rejects.toThrow(/permission denied/);
    } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
  });

  it("a prompt names a salon, a clinic or an NBFC without any of it reaching the history as markup", async () => {
    const b = await owner();
    script(say("ok"));
    await talk(b, { messages: said("<script>alert(1)</script> ask for EMI date\nand loan id") });
    const e = (await b.get("/api/assistant/history")).body.entries[0];
    expect(e.prompt).toContain("<script>"); // stored verbatim; the page shows it as text
    expect(e.prompt.length).toBeLessThanOrEqual(600);
  });
});
