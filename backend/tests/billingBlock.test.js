// The Studio tells the phone server whether a call may be answered: an organization whose plan is not open, or
// that has no minutes left, gets no agent on its inbound calls (the phone server says a short message instead).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { db, freshDb, internal, line, owner, publish, OURS } from "./helpers.js";
import * as Billing from "../src/models/Billing.js";

beforeAll(() => { config.BILLING_ENFORCED = true; });
afterAll(() => { config.BILLING_ENFORCED = false; });
beforeEach(freshDb);

let people = 0;
async function team(planId = "start") {
  const k = ++people;
  const b = await owner({ email: `p${k}@acme.in`, organization: `Acme ${k}` });
  if (planId) await Billing.assign(b.user.org_id, { planId, adminEmail: "t@kaho.in" });
  await line(b);
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  await publish(b, a.id).catch(() => {}); // a new agent is already live
  return { b, a };
}
const configFor = async (a) => (await internal("get", `/internal/v1/call-config?agent_id=${a.id}`)).body.config;

describe("call-config says whether the call may be answered", () => {
  it("not blocked while the plan is open and there are minutes", async () => {
    const { a } = await team();
    expect((await configFor(a)).blocked).toBeNull();
  });

  it("blocked with no minutes left", async () => {
    const { b, a } = await team();
    await Billing.adjust(b.user.org_id, -1100, { actor: "t", note: "used up" });
    expect((await configFor(a)).blocked).toBe("no_minutes");
  });

  it.each([["suspended", "subscription_suspended"], ["expired", "subscription_expired"], ["pending", "subscription_pending"], ["cancelled", "subscription_required"]])(
    "blocked when the plan is %s", async (status, reason) => {
      const { b, a } = await team();
      await db.query("UPDATE subscriptions SET status = $2 WHERE org_id = $1", [b.user.org_id, status]);
      expect((await configFor(a)).blocked).toBe(reason);
    });

  it("blocked when the month is over, before the timer has marked it", async () => {
    const { b, a } = await team();
    await db.query("UPDATE subscriptions SET period_end = now() - interval '1 minute' WHERE org_id = $1", [b.user.org_id]);
    expect((await configFor(a)).blocked).toBe("subscription_expired");
  });

  it("an organization that never chose a plan is blocked", async () => {
    const { b, a } = await team();
    await db.query("DELETE FROM subscriptions WHERE org_id = $1", [b.user.org_id]); // as if it had never chosen
    expect((await configFor(a)).blocked).toBe("subscription_required");
  });

  it("never blocked for an unmetered organization, whatever its balance", async () => {
    const { b, a } = await team();
    await Billing.setUnmetered(b.user.org_id, true, { adminEmail: "t@kaho.in" });
    await Billing.adjust(b.user.org_id, -1100, { actor: "t", note: "x" });
    expect((await configFor(a)).blocked).toBeNull();
  });

  it("the same answer when the call is found by the number it came in on", async () => {
    const { b, a } = await team();
    await b.post(`/api/agents/${a.id}/routes`).send({ number: OURS }).catch(() => {});
    await db.query("INSERT INTO routes (number, agent_id, org_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [OURS, a.id, b.user.org_id]);
    await Billing.adjust(b.user.org_id, -1100, { actor: "t", note: "x" });
    const r = (await internal("get", `/internal/v1/call-config?number=${encodeURIComponent(OURS)}`)).body.config;
    expect(r.blocked).toBe("no_minutes");
  });

  it("is switched off with billing, so nothing else about a call changes", async () => {
    const { b, a } = await team();
    await Billing.adjust(b.user.org_id, -1100, { actor: "t", note: "x" });
    config.BILLING_ENFORCED = false;
    try { expect((await configFor(a)).blocked).toBeNull(); } finally { config.BILLING_ENFORCED = true; }
  });

  it("carries only a short reason code, never a number or a name", async () => {
    const { b, a } = await team();
    await Billing.adjust(b.user.org_id, -1100, { actor: "t", note: "Ravi Kumar 9876543210" });
    const c = await configFor(a);
    expect(c.blocked).toMatch(/^[a-z_]{1,40}$/);
    expect(JSON.stringify(c)).not.toMatch(/9876543210|Ravi/);
  });
});
