// Every long list on the admin site is paged the way the Studio's are: 10, 25 or 50 a page.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { db, freshDb, owner } from "./helpers.js";
import { CODE, signedInAdmin } from "./adminHelpers.js";
import * as Billing from "../src/models/Billing.js";

beforeAll(() => { config.BILLING_ENFORCED = true; });
afterAll(() => { config.BILLING_ENFORCED = false; });
beforeEach(async () => { config.ADMIN_SIGNUP_CODE = CODE; config.BILLING_ENFORCED = true; await freshDb(); });

async function org(name = "Acme") {
  const b = await owner({ email: `x@${name.toLowerCase()}.in`, organization: name });
  await Billing.assign(b.user.org_id, { planId: "growth", adminEmail: "t" });
  return b;
}

describe("an organization's own lists are paged on the server", () => {
  it("the minute ledger", async () => {
    const admin = await signedInAdmin(); const b = await org();
    for (let i = 0; i < 12; i++) await Billing.adjust(b.user.org_id, 1, { note: `n${i}` });
    const p1 = (await admin.get(`/orgs/${b.user.org_id}/ledger?page=1&per_page=10`)).body;
    expect(p1).toMatchObject({ page: 1, per_page: 10 }); expect(p1.entries).toHaveLength(10); expect(p1.total).toBe(13);
    expect((await admin.get(`/orgs/${b.user.org_id}/ledger?page=2&per_page=10`)).body.entries).toHaveLength(3);
    expect((await admin.get(`/orgs/${b.user.org_id}/ledger?per_page=7`)).body.per_page).toBe(10);
  });
  it("top-ups, only this organization's", async () => {
    const admin = await signedInAdmin(); const a = await org("Alpha"); const z = await org("Zeta");
    for (let i = 0; i < 11; i++) await Billing.createTopup(a.user.org_id, { userId: a.user.id, minutes: 100 + i }).catch(() => {});
    await Billing.createTopup(z.user.org_id, { userId: z.user.id, minutes: 100 });
    const r = (await admin.get(`/topups?org=${a.user.org_id}&per_page=10`)).body;
    expect(r.topups.every((t) => t.org_id === a.user.org_id)).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect((await admin.get("/topups?org=nope")).status).toBe(404);
  });
  it("recent calls, masked", async () => {
    const admin = await signedInAdmin(); const b = await org();
    for (let i = 0; i < 12; i++) {
      await db.query("INSERT INTO calls (call_id, org_id, peer, direction, status, started_at, duration_secs) VALUES ($1, $2, '+919876543210', 'outbound', 'answered', now() - make_interval(mins => $3), 30)",
        [`c0000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, b.user.org_id, i]);
    }
    const r = (await admin.get(`/orgs/${b.user.org_id}/calls?page=2&per_page=10`)).body;
    expect(r.total).toBe(12); expect(r.calls).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain("9876543210");
    expect((await admin.get("/orgs/org_zzzzzzzzzzzz/calls")).status).toBe(404);
  });
  it("need an admin", async () => {
    const b = await org();
    const { adminBrowser } = await import("./adminHelpers.js");
    expect((await adminBrowser().get(`/orgs/${b.user.org_id}/ledger`)).status).toBe(401);
    expect((await adminBrowser().get(`/orgs/${b.user.org_id}/calls`)).status).toBe(401);
  });
});
