import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app, db, freshDb, internal, line, owner, publish, OURS } from "./helpers.js";

beforeEach(freshDb);

const CALL = "33333333-3333-3333-3333-333333333333";
const lookUp = (body = {}) => internal("post", `/internal/v1/calls/${CALL}/tools/look_up_contact`).send(body);

async function onACall(b, { number = "+919876543210" } = {}) {
  await line(b);
  const contact = (await b.post("/api/contacts").send({ name: "Ravi Kumar", numbers: [number] })).body;
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call", "look_up_contact"] });
  await publish(b, a.id);
  await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: number, ours: OURS });
  return contact;
}

describe("what the agent can look up about the person it is calling", () => {
  it("gives their name and nothing else when that is all we know", async () => {
    const b = await owner();
    await onACall(b);
    const r = await lookUp();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, name: "Ravi Kumar" });
    expect(r.body.details).toEqual({});
    expect(r.body.answers).toEqual({});
  });

  it("gives what the customer's own system knows about them", async () => {
    const b = await owner();
    const contact = await onACall(b);
    await db.query("UPDATE contacts SET details = $1 WHERE id = $2",
      [JSON.stringify({ age: 34, loan_amount: 250000, branch: "Pune" }), contact.id]);
    const r = await lookUp();
    expect(r.body.details).toEqual({ age: 34, loan_amount: 250000, branch: "Pune" });
  });

  it("gives back the newest answer saved for each question", async () => {
    const b = await owner();
    await onACall(b);
    const a = (await b.get("/api/agents")).body[0];
    await b.patch(`/api/agents/${a.id}`).send({ settings: { capture_fields: [{ label: "Payment date", kind: "date" }] } });
    await publish(b, a.id);
    await internal("post", `/internal/v1/calls/${CALL}/answers`)
      .send({ agent_id: a.id, field_key: "payment_date", said: "2026-12-15", turn: 1, confirmed: true });
    const r = await lookUp();
    expect(r.body.answers).toEqual({ payment_date: "2026-12-15" });
    expect(r.body.contact_id).toBeUndefined(); // nothing internal for the agent to read out
  });

  it("says plainly when it does not know who is calling", async () => {
    const b = await owner();
    await line(b);
    await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: "+919111111111", ours: OURS });
    const r = await lookUp();
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/do not have|not have their details/i);
  });

  it("never reaches a contact in another organization with the same number", async () => {
    const b = await owner();
    await onACall(b);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    await other.post("/api/contacts").send({ name: "Someone Else", numbers: ["+919876543210"] });
    expect((await lookUp()).body.name).toBe("Ravi Kumar");
  });
});

describe("the customer's own system keeping a contact up to date", () => {
  const key = async (b) => (await b.post("/api/api-keys").send({ name: "CRM" })).body.key;
  const push = (k, body) => request(app).post("/api/v1/contacts").set("Authorization", `Bearer ${k}`).send(body);

  it("makes the contact the first time and updates it after", async () => {
    const b = await owner();
    const k = await key(b);
    const made = await push(k, { phone: "9876543210", name: "Ravi", details: { loan_amount: 250000 } });
    expect(made.status).toBe(200);

    await push(k, { phone: "9876543210", details: { loan_amount: 100000, branch: "Pune" } });
    const { rows } = await db.query("SELECT name, details FROM contacts");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Ravi");
    expect(rows[0].details).toEqual({ loan_amount: 100000, branch: "Pune" });
  });

  it("keeps details to a sensible size and shape", async () => {
    const b = await owner();
    const k = await key(b);
    expect((await push(k, { phone: "9876543210", details: "not an object" })).status).toBe(400);
    const tooMany = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, i]));
    expect((await push(k, { phone: "9876543210", details: tooMany })).status).toBe(400);
  });

  it("needs a key, and writes only into that key's organization", async () => {
    const b = await owner();
    const k = await key(b);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect((await request(app).post("/api/v1/contacts").send({ phone: "9876543210" })).status).toBe(401);
    await push(k, { phone: "9876543210", name: "Ours" });
    expect((await other.get("/api/contacts")).body.items ?? []).toHaveLength(0);
  });
});
