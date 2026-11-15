// What a customer asks Kaho for (a plan change, or any message) and how the admin site sees and answers it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { db, freshDb, member, owner } from "./helpers.js";
import { CODE, signedInAdmin } from "./adminHelpers.js";
import * as Billing from "../src/models/Billing.js";

let n = 0;
beforeAll(() => { config.BILLING_ENFORCED = true; });
afterAll(() => { config.BILLING_ENFORCED = false; });
beforeEach(async () => { config.ADMIN_SIGNUP_CODE = CODE; config.BILLING_ENFORCED = true; await freshDb(); });
const team = async (name = "Acme") => { const k = ++n; return owner({ email: `p${k}@${name.toLowerCase()}.in`, organization: name, name: `Person ${k}` }); };
const withPlan = async (b, planId = "start") => { await Billing.assign(b.user.org_id, { planId, adminEmail: "t" }); return b; };

describe("a customer writes to Kaho", () => {
  it("files a message, sees it with its status, and the team is not told the text", async () => {
    const b = await withPlan(await team());
    const r = await b.post("/api/requests").send({ message: "Please raise our calls at once to 10." });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "message", status: "open", message: "Please raise our calls at once to 10.", plan_id: null });
    const list = (await b.get("/api/requests")).body;
    expect(list.map((x) => x.status)).toEqual(["open"]);
  });

  it.each([[""], ["   "], [undefined], [5], [["a"]], [{}], ["x".repeat(1001)]])("refuses a message of %j", async (message) => {
    const b = await withPlan(await team());
    expect((await b.post("/api/requests").send({ message })).status).toBe(400);
  });

  it("only someone who manages billing writes; others can read nothing of it", async () => {
    const b = await withPlan(await team());
    const v = await member(b);
    expect((await v.post("/api/requests").send({ message: "hello there" })).status).toBe(403);
    expect((await v.get("/api/requests")).status).toBe(403);
  });

  it("keeps each organization's requests to itself", async () => {
    const a = await withPlan(await team("Alpha")); const z = await withPlan(await team("Zeta"));
    await a.post("/api/requests").send({ message: "alpha only" });
    expect((await z.get("/api/requests")).body).toEqual([]);
  });

  it("at most 20 are waiting at once", async () => {
    const b = await withPlan(await team());
    for (let i = 0; i < 20; i++) expect((await b.post("/api/requests").send({ message: `ask ${i}` })).status).toBe(200);
    expect((await b.post("/api/requests").send({ message: "one more" })).status).toBe(429);
  });

  it("asking to change plan files a plan request, and a newer one replaces the older waiting one", async () => {
    const b = await withPlan(await team());
    await b.post("/api/billing/change-request").send({ plan_id: "growth", note: "we grew" });
    await b.post("/api/billing/change-request").send({ plan_id: "scale" });
    const open = (await b.get("/api/requests")).body.filter((x) => x.status === "open");
    expect(open.map((x) => [x.kind, x.plan_id])).toEqual([["plan_change", "scale"]]);
  });
});

describe("the admin site sees and answers them", () => {
  it("lists them paged, newest waiting first, with the organization and what it is on", async () => {
    const admin = await signedInAdmin();
    const a = await withPlan(await team("Alpha"), "start"); const z = await withPlan(await team("Zeta"), "growth");
    await a.post("/api/requests").send({ message: "first" });
    await z.post("/api/billing/change-request").send({ plan_id: "scale", note: "more please" });
    const r = (await admin.get("/requests?status=open&page=1&per_page=10")).body;
    expect(r).toMatchObject({ total: 2, page: 1, per_page: 10 });
    expect(r.requests[0]).toMatchObject({ org_name: "Zeta", kind: "plan_change", plan_id: "scale", plan_name: "Scale", current_plan_name: "Growth", message: "more please" });
    for (let i = 0; i < 9; i++) await a.post("/api/requests").send({ message: `more ${i}` });
    const page2 = (await admin.get("/requests?status=open&page=2&per_page=10")).body;
    expect(page2.requests.map((x) => x.org_name)).toEqual(["Alpha"]); // 11 in all: the oldest is alone on page 2
    expect((await admin.get("/requests?status=open&per_page=7")).body.per_page).toBe(10); // only 10, 25 or 50
    expect((await admin.get("/requests?status=bogus")).status).toBe(400);
  });

  it("shows how many each organization has waiting, in the list, the organization and the overview", async () => {
    const admin = await signedInAdmin();
    const a = await withPlan(await team("Alpha")); await withPlan(await team("Beta"));
    await a.post("/api/requests").send({ message: "one" }); await a.post("/api/requests").send({ message: "two" });
    const orgs = (await admin.get("/orgs?per_page=50")).body.orgs;
    expect(orgs.find((o) => o.name === "Alpha").open_requests).toBe(2);
    expect(orgs.find((o) => o.name === "Beta").open_requests).toBe(0);
    expect((await admin.get(`/orgs/${a.user.org_id}`)).body.requests.map((x) => x.status)).toEqual(["open", "open"]);
    expect((await admin.get("/overview")).body.requests).toMatchObject({ open: 2 });
  });

  it("marks one done with an answer the customer sees and is told about; it cannot be decided twice", async () => {
    const admin = await signedInAdmin();
    const a = await withPlan(await team());
    const { body: q } = await a.post("/api/requests").send({ message: "raise limit" });
    const r = await admin.post(`/requests/${q.id}`).send({ action: "done", response: "Raised to 10." });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "done", response: "Raised to 10." });
    const mine = (await a.get("/api/requests")).body[0];
    expect(mine).toMatchObject({ status: "done", response: "Raised to 10." });
    expect((await a.get("/api/notifications")).body.items.map((i) => i.text).join("|")).toMatch(/Kaho answered your request/);
    expect((await admin.post(`/requests/${q.id}`).send({ action: "dismiss" })).status).toBe(400);
    expect((await db.query("SELECT action FROM admin_audit WHERE action = 'request.done'")).rowCount).toBe(1);
  });

  it("refuses a bad id, a bad action and a long answer", async () => {
    const admin = await signedInAdmin();
    const a = await withPlan(await team());
    const { body: q } = await a.post("/api/requests").send({ message: "hello there" });
    expect((await admin.post("/requests/nope").send({ action: "done" })).status).toBe(404);
    expect((await admin.post(`/requests/${q.id}`).send({ action: "explode" })).status).toBe(400);
    expect((await admin.post(`/requests/${q.id}`).send({ action: "done", response: "x".repeat(501) })).status).toBe(400);
    expect((await admin.post(`/requests/${q.id}`).send({ action: "done", response: ["x"] })).status).toBe(400);
  });

  it("putting the organization on the plan it asked for closes that request", async () => {
    const admin = await signedInAdmin();
    const a = await withPlan(await team(), "start");
    await a.post("/api/billing/change-request").send({ plan_id: "growth" });
    await admin.post(`/orgs/${a.user.org_id}/plan`).send({ plan_id: "growth" });
    const mine = (await a.get("/api/requests")).body;
    expect(mine[0]).toMatchObject({ kind: "plan_change", status: "done" });
  });

  it("the notification panel holds waiting requests and waiting top-ups together, newest first, paged", async () => {
    const admin = await signedInAdmin();
    const a = await withPlan(await team("Alpha"));
    await a.post("/api/requests").send({ message: "a question" });
    await Billing.createTopup(a.user.org_id, { userId: a.user.id, minutes: 100 });
    await a.post("/api/billing/change-request").send({ plan_id: "growth" });
    const r = (await admin.get("/notifications?page=1&per_page=10")).body;
    expect(r.total).toBe(3);
    expect(r.items.map((i) => i.kind).sort()).toEqual(["plan_change", "request", "topup"]);
    expect(r.items.every((i) => i.org_name === "Alpha" && i.text && i.at && i.link)).toBe(true);
    for (let i = 0; i < 8; i++) await a.post("/api/requests").send({ message: `more ${i}` });
    expect((await admin.get("/notifications?page=2&per_page=10")).body.items).toHaveLength(1); // 11 in all
  });

  it("is for admins only", async () => {
    const a = await withPlan(await team());
    const { adminBrowser } = await import("./adminHelpers.js");
    expect((await adminBrowser().get("/requests")).status).toBe(401);
    expect((await adminBrowser().get("/notifications")).status).toBe(401);
    expect((await a.get("/api/admin/requests")).status).toBeGreaterThanOrEqual(400);
  });
});
