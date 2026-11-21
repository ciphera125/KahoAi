// Top-ups: a person asks for minutes, Kaho confirms the payment, the minutes arrive, and the
// team is told at each step. Nothing is credited on a request alone.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { db, freshDb, member, owner } from "./helpers.js";
import * as Billing from "../src/models/Billing.js";

beforeAll(() => { config.BILLING_ENFORCED = true; });
afterAll(() => { config.BILLING_ENFORCED = false; });
beforeEach(freshDb);

const balance = async (org) => (await db.query("SELECT balance_minutes AS n FROM subscriptions WHERE org_id = $1", [org])).rows[0]?.n;
let people = 0;
async function subscribed(planId = "start") {
  const k = ++people;
  const b = await owner({ email: `person${k}@acme.in`, organization: `Acme ${k}` });
  await Billing.assign(b.user.org_id, { planId, adminEmail: "test@kaho.in" });
  return b;
}
const notes = async (b) => (await b.get("/api/notifications")).body.items.map((i) => i.text);

describe("asking for a top-up", () => {
  it("is priced at the plan's price for an extra minute, and credits nothing yet", async () => {
    const b = await subscribed("start"); // an extra minute costs Rs 5.50
    const r = await b.post("/api/billing/topups").send({ minutes: 250 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ minutes: 250, rate_paise: 550, amount_paise: 137500, status: "pending" });
    expect(r.body.id).toMatch(/^tp_[0-9a-f]{12}$/);
    expect(r.body.reference).toMatch(/^KAHO-[0-9A-F]{8}$/);
    expect(await balance(b.user.org_id)).toBe(1100);
  });

  it("uses the price on the person's own terms, so an admin's per-minute change is what they pay", async () => {
    const b = await subscribed("growth"); // Rs 5.00
    await Billing.setTerms(b.user.org_id, { extra_paise: 480 }, { adminEmail: "a@kaho.in" });
    expect((await b.post("/api/billing/topups").send({ minutes: 100 })).body.amount_paise).toBe(48000);
  });

  it("tells the whole team straight away, and says how to pay", async () => {
    config.BILLING_PAYMENT_INSTRUCTIONS = "Pay by UPI to kaho@upi and quote the reference.";
    try {
      const b = await subscribed();
      const r = await b.post("/api/billing/topups").send({ minutes: 100 });
      expect(r.body.how_to_pay).toMatch(/UPI/);
      const got = await notes(b);
      expect(got.some((t) => /top-up/i.test(t) && /100 minutes/.test(t) && /confirm/i.test(t))).toBe(true);
      const items = (await b.get("/api/notifications")).body.items;
      expect(items.find((i) => /top-up/i.test(i.text)).view).toBe("billing");
    } finally { delete config.BILLING_PAYMENT_INSTRUCTIONS; }
  });

  it("takes a whole number of minutes from 50 to 20,000, and nothing else", async () => {
    const b = await subscribed();
    for (const bad of [0, 49, 20001, -5, 100.5, "abc", "", null, [100], { n: 1 }, NaN]) {
      const r = await b.post("/api/billing/topups").send({ minutes: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await b.post("/api/billing/topups").send({ minutes: "100" })).status).toBe(200); // a number typed into a box
    expect((await b.post("/api/billing/topups").send({})).status).toBe(400);
  });

  it("allows only a few open requests at once, so nobody can bury the queue", async () => {
    const b = await subscribed();
    for (let i = 0; i < 5; i++) expect((await b.post("/api/billing/topups").send({ minutes: 50 })).status).toBe(200);
    const r = await b.post("/api/billing/topups").send({ minutes: 50 });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/waiting/i);
  });

  it("needs an active plan and the right to manage billing", async () => {
    const lockedOrg = await owner();
    expect((await lockedOrg.post("/api/billing/topups").send({ minutes: 100 })).status).toBe(402);
    const b = await subscribed();
    const viewer = await member(b);
    expect((await viewer.post("/api/billing/topups").send({ minutes: 100 })).status).toBe(403);
    expect((await viewer.get("/api/billing/topups")).status).toBe(200);
  });

  it("lists the organization's own requests, newest first, and nobody else's", async () => {
    const b = await subscribed();
    await b.post("/api/billing/topups").send({ minutes: 100 });
    await b.post("/api/billing/topups").send({ minutes: 200 });
    const list = (await b.get("/api/billing/topups")).body;
    expect(list.map((t) => t.minutes)).toEqual([200, 100]);
    const other = await owner({ email: "z@other.in", organization: "Other" });
    await Billing.assign(other.user.org_id, { planId: "start", adminEmail: "a@k" });
    expect((await other.get("/api/billing/topups")).body).toEqual([]);
  });

  it("can be withdrawn by the team while it is waiting, and by nobody once it is decided or from another team", async () => {
    const b = await subscribed();
    const t = (await b.post("/api/billing/topups").send({ minutes: 100 })).body;
    const other = await owner({ email: "z@other.in", organization: "Other" });
    await Billing.assign(other.user.org_id, { planId: "start", adminEmail: "a@k" });
    expect((await other.post(`/api/billing/topups/${t.id}/cancel`)).status).toBe(404);
    expect((await b.post(`/api/billing/topups/${t.id}/cancel`)).body.status).toBe("cancelled");
    expect((await b.post(`/api/billing/topups/${t.id}/cancel`)).status).toBe(400);
    expect((await b.post("/api/billing/topups/not-an-id/cancel")).status).toBe(404);
  });
});

describe("the minutes ledger says who", () => {
  it("names the person who asked for a top-up (owner, 2026-11-22)", async () => {
    const b = await subscribed();
    const t = (await b.post("/api/billing/topups").send({ minutes: 100 })).body;
    await Billing.decideTopup(t.id, { approve: true, adminEmail: "a@kaho.in" });
    const [line] = (await b.get("/api/billing/ledger?page=1&per_page=10")).body.entries;
    expect(line).toMatchObject({ kind: "topup", requested_by: "Asha Rao", confirmed_by: "Kaho AI" });
  });

  it("names who placed a call that used minutes, or says the call came in", async () => {
    const b = await subscribed();
    const org = b.user.org_id;
    await db.query("INSERT INTO calls (call_id, org_id, request_uuid, direction, peer) VALUES ('call-out-0001', $1, 'req-out-0001', 'outbound', '+919800000001'), ('call-in-00001', $1, NULL, 'inbound', '+919800000002')", [org]);
    await db.query("INSERT INTO activity (id, org_id, kind, text, view, ref, actor) VALUES ('ac_t1', $1, 'call', 'Called', 'calls', 'req-out-0001', 'Asha Rao')", [org]);
    await db.query("INSERT INTO minute_ledger (org_id, kind, minutes, call_id) VALUES ($1, 'usage', -2, 'call-out-0001'), ($1, 'usage', -1, 'call-in-00001')", [org]);
    const lines = (await b.get("/api/billing/ledger?page=1&per_page=10")).body.entries.filter((e) => e.kind === "usage");
    expect(lines.find((l) => l.call_id === "call-out-0001")).toMatchObject({ requested_by: "Asha Rao", direction: "outbound", peer: "+919800000001" });
    expect(lines.find((l) => l.call_id === "call-in-00001")).toMatchObject({ requested_by: null, direction: "inbound" });
  });
});

describe("Kaho confirming a payment", () => {
  it("credits the minutes once, tells the team, and shows the new balance", async () => {
    const b = await subscribed();
    const t = (await b.post("/api/billing/topups").send({ minutes: 250 })).body;
    const done = await Billing.decideTopup(t.id, { approve: true, adminEmail: "a@kaho.in", note: "UPI ref 12345" });
    expect(done).toMatchObject({ status: "paid", minutes: 250 });
    expect(await balance(b.user.org_id)).toBe(1350);
    const got = await notes(b);
    expect(got.some((x) => /250 minutes added/.test(x) && /1,?350/.test(x))).toBe(true);
    const ledger = (await b.get("/api/billing/ledger?page=1&per_page=10")).body.entries;
    expect(ledger[0]).toMatchObject({ kind: "topup", minutes: 250 });
  });

  it("cannot be confirmed twice, even at the same moment", async () => {
    const b = await subscribed();
    const t = (await b.post("/api/billing/topups").send({ minutes: 100 })).body;
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => Billing.decideTopup(t.id, { approve: true, adminEmail: "a@kaho.in" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance(b.user.org_id)).toBe(1200);
    expect((await db.query("SELECT count(*)::int AS n FROM minute_ledger WHERE kind = 'topup'")).rows[0].n).toBe(1);
  });

  it("declining credits nothing and says so", async () => {
    const b = await subscribed();
    const t = (await b.post("/api/billing/topups").send({ minutes: 100 })).body;
    await Billing.decideTopup(t.id, { approve: false, adminEmail: "a@kaho.in", note: "Payment not received" });
    expect(await balance(b.user.org_id)).toBe(1100);
    expect((await notes(b)).some((x) => /not confirmed|declined/i.test(x))).toBe(true);
    expect((await b.get("/api/billing/topups")).body[0]).toMatchObject({ status: "rejected" });
    await expect(Billing.decideTopup(t.id, { approve: true, adminEmail: "a@kaho.in" })).rejects.toThrow(/already/);
    expect(await balance(b.user.org_id)).toBe(1100);
  });

  it("a withdrawn request cannot be confirmed", async () => {
    const b = await subscribed();
    const t = (await b.post("/api/billing/topups").send({ minutes: 100 })).body;
    await b.post(`/api/billing/topups/${t.id}/cancel`);
    await expect(Billing.decideTopup(t.id, { approve: true, adminEmail: "a@kaho.in" })).rejects.toThrow(/already/);
  });

  it("an unknown request is not found", async () => {
    await expect(Billing.decideTopup("tp_000000000000", { approve: true, adminEmail: "a@kaho.in" })).rejects.toThrow(/no such/);
  });

  it("minutes added by hand are recorded, signed, with who and why, and tell the team", async () => {
    const b = await subscribed();
    await Billing.adjust(b.user.org_id, 75, { actor: "Kaho AI", note: "Goodwill for the outage" });
    expect(await balance(b.user.org_id)).toBe(1175);
    expect((await notes(b)).some((x) => /75 minutes added/.test(x))).toBe(true);
    await Billing.adjust(b.user.org_id, -25, { actor: "Kaho AI", note: "Correction" });
    expect(await balance(b.user.org_id)).toBe(1150);
    await expect(Billing.adjust(b.user.org_id, 0, { actor: "x", note: "" })).rejects.toThrow(/minutes/);
    await expect(Billing.adjust(b.user.org_id, 1.5, { actor: "x", note: "" })).rejects.toThrow(/whole/);
    await expect(Billing.adjust(b.user.org_id, 5_000_000, { actor: "x", note: "" })).rejects.toThrow(/at most/);
  });
});
