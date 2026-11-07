import { beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, line, owner, publish, OURS } from "./helpers.js";
import * as Agent from "../src/models/Agent.js";
import { fill, namesOf, offered } from "../src/models/variables.js";

beforeEach(freshDb);

const NOW = new Date("2026-11-09T10:00:00Z"); // Monday, 3:30 pm India time

describe("what the prompt editor offers", () => {
  it("groups the contact's details, the saved answers and the call's own facts", () => {
    const groups = offered({ captureFields: [{ key: "payment_date", label: "Payment date" }],
      detailKeys: ["loan_amount"] });
    expect(groups.map((g) => g.group)).toEqual(["Contact details", "Saved answers", "About the call"]);
    expect(namesOf(groups)).toEqual(["customer_name", "customer_phone", "detail.loan_amount",
      "answer.payment_date", "today", "now", "agent_name"]);
  });

  it("offers the detail fields this organization actually sends, not a guess", async () => {
    const b = await owner();
    const c = (await b.post("/api/contacts").send({ name: "Ravi", numbers: ["+919876543210"] })).body;
    await db.query("UPDATE contacts SET details = $1 WHERE id = $2", [JSON.stringify({ loan_amount: 1, branch: "Pune" }), c.id]);
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "Hi" })).body;
    const r = await b.get(`/api/agents/${a.id}/variables`);
    expect(r.status).toBe(200);
    expect(namesOf(r.body)).toEqual(expect.arrayContaining(["detail.branch", "detail.loan_amount", "customer_name"]));
  });
});

describe("filling a prompt in before the call", () => {
  it("puts the person's name, details and last answers in", async () => {
    const b = await owner();
    await line(b);
    const c = (await b.post("/api/contacts").send({ name: "Ravi Kumar", numbers: ["+919876543210"] })).body;
    await db.query("UPDATE contacts SET details = $1 WHERE id = $2", [JSON.stringify({ loan_amount: 250000 }), c.id]);

    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "Hi" })).body;
    await b.patch(`/api/agents/${a.id}`).send({ settings: { capture_fields: [{ label: "Payment date", kind: "date" }] } });
    await publish(b, a.id);
    const callId = "44444444-4444-4444-4444-444444444444";
    await internal("put", `/internal/v1/calls/${callId}`)
      .send({ status: "answered", peer: "+919876543210", ours: OURS, agent_id: a.id });
    await internal("post", `/internal/v1/calls/${callId}/answers`)
      .send({ field_key: "payment_date", said: "2026-12-15", turn: 1, confirmed: true });

    const out = await fill(
      "Hello {{customer_name}}, about your {{detail.loan_amount}} loan, due {{answer.payment_date}}.",
      { orgId: c.org_id ?? (await b.get("/api/me")).body.org_id, contactId: c.id, now: NOW });
    expect(out).toBe("Hello Ravi Kumar, about your 250000 loan, due 2026-12-15.");
  });

  it("says the date and time in India, and names the agent", async () => {
    const out = await fill("Today is {{today}}, it is {{now}}. I am {{agent_name}}.",
      { orgId: "org_x", agentName: "Ria", now: NOW });
    expect(out).toContain("Monday, 9 November 2026");
    expect(out).toMatch(/3:30 pm/);
    expect(out).toContain("I am Ria.");
  });

  it("leaves nothing in the prompt for the agent to read out when we do not know", async () => {
    const out = await fill("Hello {{customer_name}}.", { orgId: "org_x", contactId: null, now: NOW });
    expect(out).toBe("Hello .");
    expect(out).not.toContain("{{");
  });

  it("is left alone when there is nothing to fill", async () => {
    expect(await fill("Plain words.", { orgId: "org_x" })).toBe("Plain words.");
  });
});

describe("the call gets the filled-in prompt, not the raw one", () => {
  it("fills it in for the person on the other end", async () => {
    const b = await owner();
    await line(b);
    await b.post("/api/contacts").send({ name: "Ravi Kumar", numbers: ["+919876543210"] });
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "Hello {{customer_name}}." })).body;
    await publish(b, a.id).catch(() => {}); // the prompt was set at creation, so it may already be live

    const cfg = await Agent.callConfig(a.id, { caller: "+919876543210" });
    expect(cfg.prompt).toBe("Hello Ravi Kumar.");
  });

  it("still works, with nothing left showing, for a number we have never seen", async () => {
    const b = await owner();
    await line(b);
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "Hello {{customer_name}}." })).body;
    const cfg = await Agent.callConfig(a.id, { caller: "+919999999999" });
    expect(cfg.prompt).toBe("Hello .");
  });

  it("a prompt with no variables costs nothing extra", async () => {
    const b = await owner();
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    expect((await Agent.callConfig(a.id)).prompt).toBe("You are Ria.");
  });
});
