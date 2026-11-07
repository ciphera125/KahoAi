import { beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, line, owner, publish, OURS } from "./helpers.js";
import * as Agent from "../src/models/Agent.js";

beforeEach(freshDb);

const FIELDS = [
  { label: "Payment date", kind: "date", required: true, ask: "On what exact date will you pay?" },
  { label: "Amount", kind: "amount" },
  { label: "Will pay", kind: "yes_no" },
];

async function agentWithFields(b, fields = FIELDS) {
  const a = (await b.post("/api/agents").send({ name: "Collections", prompt: "You are Ria." })).body;
  const r = await b.patch(`/api/agents/${a.id}`).send({ settings: { capture_fields: fields } });
  if (r.status !== 200) throw new Error(`setting fields failed: ${JSON.stringify(r.body)}`);
  await publish(b, a.id);
  return { ...a, settings: r.body.settings };
}

/** A call that has already come in on this organization's line, with a contact. */
async function callFor(b, agent, { callId = "11111111-1111-1111-1111-111111111111", number = "+919876543210" } = {}) {
  await line(b); // our number: how a call is tied to an organization
  const contact = (await b.post("/api/contacts").send({ name: "Ravi", numbers: [number] })).body;
  // The agent that answered is recorded on the call, as the voice service does when it
  // reports the call: it is the only place the Studio learns which agent this is.
  await internal("put", `/internal/v1/calls/${callId}`)
    .send({ status: "answered", peer: number, ours: OURS, agent_id: agent.id });
  return { callId, contact };
}

const save = (callId, body) => internal("post", `/internal/v1/calls/${callId}/answers`).send(body);

describe("the questions an agent asks are part of its settings", () => {
  it("gives each one a key from its label, and keeps the order", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    expect(a.settings.capture_fields.map((f) => f.key)).toEqual(["payment_date", "amount", "will_pay"]);
    expect(a.settings.capture_fields[0]).toMatchObject({ label: "Payment date", kind: "date", required: true });
  });

  it("refuses a kind we cannot read back, and a choice field with no choices", async () => {
    const b = await owner();
    const a = (await b.post("/api/agents").send({ name: "X", prompt: "Hi" })).body;
    const bad = await b.patch(`/api/agents/${a.id}`).send({ settings: { capture_fields: [{ label: "Colour", kind: "colour" }] } });
    expect(bad.status).toBe(400);
    const noChoices = await b.patch(`/api/agents/${a.id}`).send({ settings: { capture_fields: [{ label: "How", kind: "choice" }] } });
    expect(noChoices.status).toBe(400);
    expect(noChoices.body.error).toMatch(/choice/i);
  });

  it("reaches the voice service with the call's settings", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const cfg = await Agent.callConfig(a.id);
    expect(cfg.capture_fields.map((f) => f.key)).toEqual(["payment_date", "amount", "will_pay"]);
    expect(cfg.confirm_answers).toBe(true);
  });
});

describe("which agent's questions apply", () => {
  it("is the agent that answered the call, which the voice service never has to say", async () => {
    // The voice service sends the field and the words. It does not send an agent, and the
    // Studio must not need one: it reads it from the call. (2026-11-08: the first version
    // read it from the request, so on a real call every answer was refused.)
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId } = await callFor(b, a);
    const r = await save(callId, { field_key: "amount", said: "500", turn: 1, confirmed: true });
    expect(r.body).toMatchObject({ ok: true, value: "500" });
  });

  it("cannot be changed by naming a different agent in the request", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const other = (await b.post("/api/agents").send({ name: "Other", prompt: "Hi" })).body;
    await b.patch(`/api/agents/${other.id}`).send({ settings: { capture_fields: [{ label: "Secret", kind: "text" }] } });
    await publish(b, other.id);
    const { callId } = await callFor(b, a);
    const r = await save(callId, { agent_id: other.id, field_key: "secret", said: "x", turn: 1 });
    expect(r.body.ok).toBe(false);
    expect((await db.query("SELECT 1 FROM call_answers")).rowCount).toBe(0);
  });

  it("says plainly when the call has no agent, rather than guessing one", async () => {
    const b = await owner();
    await agentWithFields(b);
    await line(b);
    await internal("put", "/internal/v1/calls/11111111-1111-1111-1111-111111111111")
      .send({ status: "answered", peer: "+919876543210", ours: OURS });
    const r = await save("11111111-1111-1111-1111-111111111111", { field_key: "amount", said: "500", turn: 1 });
    expect(r.body.ok).toBe(false);
  });
});

describe("saving what the caller said", () => {
  it("normalises the value and ties it to the call's organization and contact", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId, contact } = await callFor(b, a);
    const r = await save(callId, { field_key: "payment_date", said: "15 December 2026", turn: 4, confirmed: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, value: "2026-12-15" });

    const { rows } = await db.query("SELECT * FROM call_answers WHERE call_id = $1", [callId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ field_key: "payment_date", value: "2026-12-15", label: "Payment date",
      kind: "date", raw_text: "15 December 2026", source: "tool_call", contact_id: contact.id });
    expect(rows[0].org_id).toMatch(/^org_/);
  });

  it("never takes the organization or the contact from what it is sent", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId, contact } = await callFor(b, a);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    const theirContact = (await other.post("/api/contacts").send({ name: "Someone else", numbers: ["+919000000001"] })).body;

    await save(callId, { field_key: "amount", said: "500", turn: 1, confirmed: true,
      org_id: "org_000000000000", contact_id: theirContact.id, source: "studio" });

    const { rows } = await db.query("SELECT org_id, contact_id, source FROM call_answers WHERE call_id = $1", [callId]);
    expect(rows[0].contact_id).toBe(contact.id);
    expect(rows[0].org_id).not.toBe("org_000000000000");
    expect(rows[0].source).toBe("tool_call");
  });

  it("tells the agent what to ask again when it cannot read the answer", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId } = await callFor(b, a);
    const r = await save(callId, { field_key: "payment_date", said: "sometime soon", turn: 2, confirmed: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/exact date/i);
    expect((await db.query("SELECT 1 FROM call_answers")).rowCount).toBe(0);
  });

  it("will not save a date, amount or number until the caller has confirmed it", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId } = await callFor(b, a);
    const r = await save(callId, { field_key: "payment_date", said: "tomorrow", turn: 3 });
    expect(r.body).toMatchObject({ ok: false });
    expect(r.body.message).toMatch(/read it back|confirm/i);
    expect(r.body.value).toBeTruthy(); // it tells the agent what to read back
    expect((await db.query("SELECT 1 FROM call_answers")).rowCount).toBe(0);

    const yes = await save(callId, { field_key: "payment_date", said: "tomorrow", turn: 3, confirmed: true });
    expect(yes.body.ok).toBe(true);
    expect((await db.query("SELECT 1 FROM call_answers")).rowCount).toBe(1);
  });

  it("does not ask for a read-back on a yes or no", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId } = await callFor(b, a);
    const r = await save(callId, { field_key: "will_pay", said: "haan ji", turn: 1 });
    expect(r.body).toMatchObject({ ok: true, value: "yes" });
  });

  it("can be switched off for an agent that does not want read-backs", async () => {
    const b = await owner();
    const a = (await b.post("/api/agents").send({ name: "Quick", prompt: "Hi" })).body;
    await b.patch(`/api/agents/${a.id}`).send({ settings: { capture_fields: FIELDS, confirm_answers: false } });
    await publish(b, a.id);
    const { callId } = await callFor(b, a);
    const r = await save(callId, { field_key: "payment_date", said: "tomorrow", turn: 1 });
    expect(r.body.ok).toBe(true);
  });

  it("the same answer sent twice leaves one row", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId } = await callFor(b, a);
    const body = { field_key: "amount", said: "2 lakh", turn: 7, confirmed: true };
    await save(callId, body);
    await save(callId, body);
    const { rows } = await db.query("SELECT value FROM call_answers WHERE call_id = $1", [callId]);
    expect(rows).toEqual([{ value: "200000" }]);
  });

  it("a corrected answer on a later turn is kept beside the first", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId } = await callFor(b, a);
    await save(callId, { field_key: "amount", said: "500", turn: 2, confirmed: true });
    await save(callId, { field_key: "amount", said: "5000", turn: 5, confirmed: true });
    const { rows } = await db.query("SELECT value FROM call_answers WHERE call_id = $1 ORDER BY at, id", [callId]);
    expect(rows.map((r) => r.value)).toEqual(["500", "5000"]);
  });

  it("refuses a field the agent was never given", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId } = await callFor(b, a);
    const r = await save(callId, { field_key: "secret_notes", said: "x", turn: 1, confirmed: true });
    expect(r.body.ok).toBe(false);
    expect((await db.query("SELECT 1 FROM call_answers")).rowCount).toBe(0);
  });

  it("needs the service token, like every other internal route", async () => {
    const r = await internal("post", "/internal/v1/calls/11111111-1111-1111-1111-111111111111/answers")
      .set("Authorization", "Bearer wrong").send({ field_key: "amount", said: "1" });
    expect(r.status).toBe(401);
  });

  it("masks anything sensitive the caller said, like everything else written down", async () => {
    const b = await owner();
    const a = await agentWithFields(b, [{ label: "Note", kind: "text" }]);
    const { callId } = await callFor(b, a);
    await save(callId, { field_key: "note", said: "my Aadhaar is 234567890123", turn: 1 });
    const { rows } = await db.query("SELECT value, raw_text FROM call_answers WHERE call_id = $1", [callId]);
    expect(rows[0].value).not.toContain("234567890123");
    expect(rows[0].raw_text).not.toContain("234567890123");
  });
});

describe("where the answers show up", () => {
  it("on the call, newest last", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId } = await callFor(b, a);
    await save(callId, { field_key: "payment_date", said: "tomorrow", turn: 1, confirmed: true });
    await save(callId, { field_key: "amount", said: "1500", turn: 2, confirmed: true });
    const r = await b.get(`/api/calls/${callId}/answers`);
    expect(r.status).toBe(200);
    expect(r.body.map((x) => [x.label, x.value])).toEqual([["Payment date", expect.any(String)], ["Amount", "1500"]]);
  });

  it("on the contact, with the call they came from", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId, contact } = await callFor(b, a);
    await save(callId, { field_key: "amount", said: "1500", turn: 2, confirmed: true });
    const r = await b.get(`/api/contacts/${contact.id}/answers`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ field_key: "amount", value: "1500", call_id: callId });
  });

  it("never across organizations", async () => {
    const b = await owner();
    const a = await agentWithFields(b);
    const { callId } = await callFor(b, a);
    await save(callId, { field_key: "amount", said: "1500", turn: 1, confirmed: true });
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect((await other.get(`/api/calls/${callId}/answers`)).status).toBe(404);
  });
});
