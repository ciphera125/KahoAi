import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, member, owner } from "./helpers.js";
import { useModel } from "../src/models/llm.js";

beforeEach(freshDb);
afterEach(() => useModel(null));

const propose = (args) => ({ message: { content: null, tool_calls: [{ id: "c1", function: { name: "propose", arguments: JSON.stringify(args) } }] } });
const newAgent = async (b) => (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
const talk = (b, body) => b.post("/api/assistant/message").send(body);
const said = (text) => [{ role: "user", content: text }];
const WRITE_DOWN = { kind: "write_down", summary: "The agent will ask for the EMI date.", fields: [{ label: "EMI date", kind: "date" }] };
const LOOK_UP = { kind: "look_up", summary: "The agent will check the booking.", label: "Check booking", description: "Use when the caller asks about a booking.",
  inputs: [{ label: "Booking id", type: "text" }], url: "https://api.example.com/booking" };
const TOOL = { label: "Check stock", description: "Use when asked about stock.", url: "https://api.example.com/stock", method: "POST", inputs: [{ label: "Item", type: "text" }] };

const log = async (b, q = "") => (await b.get(`/api/tool-log${q}`)).body;

describe("every tool that is made, changed or removed leaves a record", () => {
  it("records what Kaho Builder builds, with the prompt it came from", async () => {
    const b = await owner();
    const a = await newAgent(b);
    useModel(async () => propose(WRITE_DOWN));
    await talk(b, { agent_id: a.id, messages: said("ask for the EMI date") });
    const l = await log(b);
    expect(l.entries[0]).toMatchObject({ action: "built", source: "builder", kind: "write_down", tool_label: "EMI date",
      agent_id: a.id, actor: "Asha Rao", role: "owner", detail: expect.stringMatching(/EMI date/) });
    const h = (await b.get("/api/assistant/history")).body.entries[0];
    expect(l.entries[0].history_id).toBe(h.id);
  });

  it("records a look-up tool, its being undone, and a tool added or changed or removed by hand", async () => {
    const b = await owner();
    const a = await newAgent(b);
    useModel(async () => propose(LOOK_UP));
    const built = (await talk(b, { agent_id: a.id, messages: said("check the booking on our system https://api.example.com/booking") })).body;
    await b.post("/api/assistant/undo").send({ agent_id: a.id, undo: built.undo });
    const made = (await b.post("/api/custom-tools").send(TOOL)).body;
    await b.patch(`/api/custom-tools/${made.id}`).send({ description: "Use when asked about stock levels." });
    await b.delete(`/api/custom-tools/${made.id}`);
    const actions = (await log(b)).entries.map((e) => `${e.source}:${e.action}`);
    expect(actions).toEqual(["studio:removed", "studio:updated", "studio:created", "builder:undone", "builder:built"]);
  });

  it("is read only by people who can see tools, and only for their own organization", async () => {
    const b = await owner();
    const a = await newAgent(b);
    useModel(async () => propose(WRITE_DOWN));
    await talk(b, { agent_id: a.id, messages: said("x") });
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect((await log(other)).entries).toEqual([]);
    const v = await member(b, { email: "v@acme.in", name: "V" });
    expect((await v.get("/api/tool-log")).status).toBe(403);
  });

  it("also shows up in the audit log, so there is one place to see who changed what", async () => {
    const b = await owner();
    const a = await newAgent(b);
    useModel(async () => propose(WRITE_DOWN));
    await talk(b, { agent_id: a.id, messages: said("x") });
    const audit = (await b.get("/api/audit?per_page=50&q=Kaho%20Builder")).body.entries;
    expect(audit[0]).toMatchObject({ action: "builder", detail: expect.stringMatching(/Kaho Builder .*EMI date/) });
  });

  it("is append only for the application", async () => {
    const b = await owner();
    const a = await newAgent(b);
    useModel(async () => propose(WRITE_DOWN));
    await talk(b, { agent_id: a.id, messages: said("x") });
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE kaho_app");
      await expect(c.query("DELETE FROM tool_log")).rejects.toThrow(/permission denied/);
    } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
  });
});
