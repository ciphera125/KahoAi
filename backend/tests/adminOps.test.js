// What an admin can do to any organization and any person on the platform, and that each of it is
// recorded, told to the people it touches, and refused when it is nonsense.
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { app, browser, db, freshDb, internal, member, owner } from "./helpers.js";
import { adminBrowser, AYUSHI, CODE, signedInAdmin } from "./adminHelpers.js";
import * as Billing from "../src/models/Billing.js";

let people = 0;
beforeAll(() => { config.BILLING_ENFORCED = true; });
afterAll(() => { config.BILLING_ENFORCED = false; config.SUBSCRIPTION_AUTO_ACTIVATE = false; });
beforeEach(async () => {
  config.ADMIN_SIGNUP_CODE = CODE;
  config.BILLING_ENFORCED = true;
  await freshDb();
});

async function team(name = "Acme") {
  const k = ++people;
  const b = await owner({ email: `owner${k}@${name.toLowerCase()}.in`, organization: name, name: `Owner ${k}` });
  return b;
}
const orgOf = (b) => b.user.org_id;
const notes = async (b) => (await b.get("/api/notifications")).body.items.map((i) => i.text);
const adminLog = async () => (await db.query("SELECT admin_email, action, org_id, target, detail FROM admin_audit ORDER BY id")).rows;

describe("the overview", () => {
  it("counts organizations by where they are, people, money and what is waiting", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha"); const b = await team("Beta"); await team("Gamma");
    await Billing.assign(orgOf(a), { planId: "growth", adminEmail: "t" });
    await b.post("/api/billing/subscribe").send({ plan_id: "start" });
    await Billing.createTopup(orgOf(a), { userId: a.user.id, minutes: 100 });
    const r = (await admin.get("/overview")).body;
    expect(r.orgs).toMatchObject({ total: 3, active: 1, pending: 1, no_plan: 1 });
    expect(r.users.total).toBe(3);
    expect(r.revenue.mrr_paise).toBe(899900);
    expect(r.topups).toMatchObject({ pending: 1, pending_paise: 50000 });
  });
});

describe("organizations", () => {
  it("lists them with their plan and balance, searches by name or owner, and filters by status", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha"); const b = await team("Beta");
    await Billing.assign(orgOf(a), { planId: "start", adminEmail: "t" });
    await b.post("/api/billing/subscribe").send({ plan_id: "scale" });
    const all = (await admin.get("/orgs")).body;
    expect(all.total).toBe(2);
    const alpha = all.orgs.find((o) => o.name === "Alpha");
    expect(alpha).toMatchObject({ plan_id: "start", status: "active", balance_minutes: 1100, members: 1 });
    expect(alpha.owner_email).toMatch(/@alpha\.in$/);
    expect((await admin.get("/orgs?q=beta")).body.orgs.map((o) => o.name)).toEqual(["Beta"]);
    expect((await admin.get(`/orgs?q=${encodeURIComponent(a.user.email)}`)).body.orgs.map((o) => o.name)).toEqual(["Alpha"]);
    expect((await admin.get("/orgs?status=pending")).body.orgs.map((o) => o.name)).toEqual(["Beta"]);
    expect((await admin.get("/orgs?status=none")).body.orgs).toEqual([]);
    expect((await admin.get("/orgs?status=%27%3B%20DROP%20TABLE%20users%3B--")).status).toBe(400);
    expect((await admin.get("/orgs?q=%25%27%20OR%201%3D1--")).status).toBe(200);
    expect((await db.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(2);
  });

  it("pages through them in the same sizes as everywhere else", async () => {
    const admin = await signedInAdmin();
    for (let i = 0; i < 12; i++) await team(`Org${i}`);
    const p1 = (await admin.get("/orgs?per_page=10&page=1")).body;
    const p2 = (await admin.get("/orgs?per_page=10&page=2")).body;
    expect([p1.orgs.length, p2.orgs.length, p1.total]).toEqual([10, 2, 12]);
    expect((await admin.get("/orgs?per_page=7")).status).toBe(400);
    expect((await admin.get("/orgs?page=1e99")).status).toBe(200);
  });

  it("shows one organization whole: people, plan, wallet, top-ups, recent calls", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await member(a);
    await Billing.assign(orgOf(a), { planId: "growth", adminEmail: "t" });
    await Billing.createTopup(orgOf(a), { userId: a.user.id, minutes: 100 });
    const d = (await admin.get(`/orgs/${orgOf(a)}`)).body;
    expect(d.org).toMatchObject({ id: orgOf(a), name: "Alpha" });
    expect(d.members.map((m) => m.role).sort()).toEqual(["admin", "viewer"]);
    expect(d.subscription).toMatchObject({ plan_id: "growth", status: "active", balance_minutes: 2000 });
    expect(d.subscription.terms.extra_paise).toBe(500);
    expect(d.ledger[0]).toMatchObject({ kind: "plan", minutes: 2000 });
    expect(d.topups).toHaveLength(1);
    expect(d.members[0].hash ?? d.members[0].salt).toBeUndefined();
    expect(JSON.stringify(d)).not.toMatch(/auth_token|SECRETS|"hash"|"salt"/);
  });

  it("is a 404 for an organization that does not exist or an id that is not one", async () => {
    const admin = await signedInAdmin();
    for (const id of ["org_000000000000", "nope", "1;DROP", "%00"]) expect((await admin.get(`/orgs/${id}`)).status, id).toBe(404);
    expect((await admin.post("/orgs/org_000000000000/minutes").send({ minutes: 5 })).status).toBe(404);
  });

  it("renames one", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    expect((await admin.patch(`/orgs/${orgOf(a)}`).send({ name: "Alpha Finance" })).body.name).toBe("Alpha Finance");
    expect((await a.get("/api/me")).body.org_name).toBe("Alpha Finance");
    for (const bad of ["", "x".repeat(81), ["a"], null]) expect((await admin.patch(`/orgs/${orgOf(a)}`).send({ name: bad })).status).toBe(400);
  });
});

describe("plans and per-minute terms", () => {
  it("puts an organization on a plan: the Studio opens, the minutes arrive, the team is told, the admin is on record", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    expect((await a.get("/api/agents")).status).toBe(402);
    const r = await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "growth" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plan_id: "growth", status: "active", balance_minutes: 2000 });
    expect((await a.get("/api/agents")).status).toBe(200);
    expect((await notes(a)).some((t) => /plan is now Growth/.test(t))).toBe(true);
    const log = await adminLog();
    expect(log.at(-1)).toMatchObject({ admin_email: admin.admin.email, action: "plan.assign", org_id: orgOf(a) });
  });

  it("sets this customer's own per-minute terms, and top-ups, limits and bulk calls follow them", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "growth" });
    const r = await admin.patch(`/orgs/${orgOf(a)}/terms`).send({ terms: { extra_paise: 400, rate_paise: 420, simultaneous: 3, minutes_included: 2500 } });
    expect(r.status).toBe(200);
    expect(r.body.terms).toMatchObject({ extra_paise: 400, rate_paise: 420, simultaneous: 3, minutes_included: 2500, price_paise: 899900 });
    expect((await a.post("/api/billing/topups").send({ minutes: 100 })).body.amount_paise).toBe(40000);
    expect((await a.get("/api/billing")).body.simultaneous).toBe(3);
    for (const bad of [{ simultaneous: 0 }, { extra_paise: -1 }, { evil: 1 }, { rate_paise: 2.5 }, { support: 5 }]) {
      expect((await admin.patch(`/orgs/${orgOf(a)}/terms`).send({ terms: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await admin.patch(`/orgs/${orgOf(a)}/terms`).send({ terms: {} })).status).toBe(400);
    expect((await admin.patch(`/orgs/${orgOf(a)}/terms`).send({})).status).toBe(400);
  });

  it("gives Enterprise its own terms, and refuses to start it without them", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    expect((await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "enterprise" })).status).toBe(400);
    const r = await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "enterprise",
      terms: { price_paise: 4000000, minutes_included: 9000, rate_paise: 375, extra_paise: 400, simultaneous: 25, log_days: 730 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ balance_minutes: 9000, plan_id: "enterprise" });
  });

  it("adds and removes minutes by hand, with a reason, and the team is told", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "start" });
    const up = await admin.post(`/orgs/${orgOf(a)}/minutes`).send({ minutes: 300, note: "Goodwill" });
    expect(up.body.balance_minutes).toBe(1400);
    const down = await admin.post(`/orgs/${orgOf(a)}/minutes`).send({ minutes: -100, note: "Correction" });
    expect(down.body.balance_minutes).toBe(1300);
    expect((await notes(a)).some((t) => /300 minutes added/.test(t))).toBe(true);
    for (const bad of [0, 1.5, "10", null, 2_000_000, [5]]) expect((await admin.post(`/orgs/${orgOf(a)}/minutes`).send({ minutes: bad })).status, JSON.stringify(bad)).toBe(400);
    expect((await adminLog()).filter((l) => l.action === "minutes.adjust")).toHaveLength(2);
  });

  it("suspends, switches back on, cancels, renews, and makes metering optional", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "start" });
    expect((await admin.post(`/orgs/${orgOf(a)}/status`).send({ status: "suspended" })).body.status).toBe("suspended");
    expect((await a.get("/api/agents")).body.code).toBe("subscription_suspended");
    expect((await admin.post(`/orgs/${orgOf(a)}/status`).send({ status: "active" })).body.status).toBe("active");
    expect((await a.get("/api/agents")).status).toBe(200);
    expect((await admin.post(`/orgs/${orgOf(a)}/status`).send({ status: "bogus" })).status).toBe(400);
    await db.query("UPDATE subscriptions SET period_end = now() - interval '1 day', status = 'expired' WHERE org_id = $1", [orgOf(a)]);
    const renewed = (await admin.post(`/orgs/${orgOf(a)}/renew`).send({})).body;
    expect(renewed).toMatchObject({ status: "active", balance_minutes: 2200 });
    expect((await admin.post(`/orgs/${orgOf(a)}/unmetered`).send({ unmetered: true })).body.unmetered).toBe(true);
    expect((await a.get("/api/me")).body.billing).toMatchObject({ unmetered: true, minutes_left: null });
    expect((await admin.post(`/orgs/${orgOf(a)}/unmetered`).send({ unmetered: "yes" })).status).toBe(400);
  });

  it("edits the rate card for the next customer without touching anyone already on a plan", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "start" });
    const r = await admin.patch("/plans/start").send({ price_paise: 599900, extra_paise: 600, name: "Starter" });
    expect(r.body).toMatchObject({ price_paise: 599900, extra_paise: 600, name: "Starter" });
    expect((await a.get("/api/plans")).body.find((p) => p.id === "start")).toMatchObject({ price_paise: 599900, name: "Starter" });
    expect((await a.get("/api/billing")).body.terms).toMatchObject({ price_paise: 549900, extra_paise: 550 });
    expect((await admin.patch("/plans/start").send({ active: false })).body.active).toBe(false);
    expect((await a.get("/api/plans")).body.map((p) => p.id)).not.toContain("start");
    expect((await admin.get("/plans")).body.map((p) => p.id)).toContain("start"); // an admin still sees it
    for (const bad of [{ price_paise: -1 }, { evil: 1 }, { name: "" }, { highlighted: "yes" }]) {
      expect((await admin.patch("/plans/start").send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await admin.patch("/plans/nope").send({ name: "x" })).status).toBe(400);
  });

  it("only one plan is 'most chosen' at a time", async () => {
    const admin = await signedInAdmin();
    await admin.patch("/plans/scale").send({ highlighted: true });
    const list = (await admin.get("/plans")).body;
    expect(list.filter((p) => p.highlighted).map((p) => p.id)).toEqual(["scale"]);
  });

  it("answers a customer's request to move plans: it shows in the list until it is handled", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "start" });
    await a.post("/api/billing/change-request").send({ plan_id: "scale", note: "We are growing" });
    const d = (await admin.get(`/orgs/${orgOf(a)}`)).body;
    expect(d.subscription).toMatchObject({ requested_plan_id: "scale", request_note: "We are growing" });
    expect((await admin.get("/orgs?status=requested")).body.orgs.map((o) => o.name)).toEqual(["Alpha"]);
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "scale" });
    expect((await admin.get("/orgs?status=requested")).body.orgs).toEqual([]);
  });
});

describe("top-ups", () => {
  it("shows the waiting ones first, and confirming one credits the minutes and tells the team", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "start" });
    const t1 = (await a.post("/api/billing/topups").send({ minutes: 250 })).body;
    const t2 = (await a.post("/api/billing/topups").send({ minutes: 100 })).body;
    await admin.post(`/topups/${t2.id}/reject`).send({ note: "Payment not received" });
    const list = (await admin.get("/topups")).body;
    expect(list.topups.map((t) => t.status)).toEqual(["pending", "rejected"]);
    expect(list.topups[0]).toMatchObject({ id: t1.id, org_name: "Alpha", reference: t1.reference, amount_paise: 137500 });
    const done = await admin.post(`/topups/${t1.id}/approve`).send({ note: "UPI 998877" });
    expect(done.body).toMatchObject({ status: "paid", minutes: 250 });
    expect((await a.get("/api/billing")).body.minutes_left).toBe(1350);
    expect((await notes(a)).some((t) => /250 minutes added/.test(t))).toBe(true);
    expect((await admin.post(`/topups/${t1.id}/approve`).send({})).status).toBe(400);
    expect((await admin.post("/topups/tp_000000000000/approve").send({})).status).toBe(404);
    expect((await admin.get("/topups?status=pending")).body.topups).toEqual([]);
    const log = (await adminLog()).filter((l) => l.action.startsWith("topup."));
    expect(log.map((l) => l.action)).toEqual(["topup.reject", "topup.approve"]);
  });
});

describe("people", () => {
  it("finds a person anywhere on the platform, with the organizations they are in", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    const v = await member(a);
    const list = (await admin.get(`/users?q=${encodeURIComponent(v.user.email)}`)).body;
    expect(list.users).toHaveLength(1);
    expect(list.users[0]).toMatchObject({ email: v.user.email, disabled: false });
    expect(list.users[0].orgs).toEqual([{ id: orgOf(a), name: "Alpha", role: "viewer" }]);
    expect(JSON.stringify(list)).not.toMatch(/"hash"|"salt"/);
    expect((await admin.get("/users")).body.total).toBe(2);
  });

  it("lists the Kaho staff (admin accounts) beside the customers' people, without any secret", async () => {
    const admin = await signedInAdmin();
    const body = (await admin.get("/users")).body;
    expect(body.staff.length).toBeGreaterThanOrEqual(1);
    expect(body.staff[0]).toMatchObject({ email: expect.any(String), name: expect.any(String), disabled: false });
    expect(JSON.stringify(body.staff)).not.toMatch(/"hash"|"salt"/);
  });

  it("switches an account off: its sessions die at once, even the right password is refused, and back on restores it", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    const v = await member(a);
    expect((await v.get("/api/me")).status).toBe(200);
    expect((await admin.post(`/users/${v.user.id}/disable`).send({})).body.disabled).toBe(true);
    expect((await v.get("/api/me")).status).toBe(401);
    const login = await browser().post("/api/auth/login").send({ email: v.user.email, password: "another pass" });
    expect(login.status).toBe(403);
    expect(login.body.error).toMatch(/switched off/i);
    const wrong = await browser().post("/api/auth/login").send({ email: v.user.email, password: "wrong wrong" });
    expect(wrong.status).toBe(401); // a wrong password never learns the account is off
    expect((await admin.post(`/users/${v.user.id}/enable`).send({})).body.disabled).toBe(false);
    expect((await browser().post("/api/auth/login").send({ email: v.user.email, password: "another pass" })).status).toBe(200);
  });

  it("an account that is switched off has no session, however the switch was made", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    const v = await member(a);
    expect((await v.get("/api/me")).status).toBe(200);
    // not through the admin's button (which also ends the sessions): the flag alone must be enough
    await db.query("UPDATE users SET disabled_at = now() WHERE id = $1", [v.user.id]);
    expect((await v.get("/api/me")).status).toBe(401);
    await db.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [v.user.id]);
    expect((await v.get("/api/me")).status).toBe(200);
    void admin;
  });

  it("resets a password: a one-time temporary one, every session ends, the old one stops working", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    const v = await member(a);
    const r = await admin.post(`/users/${v.user.id}/reset-password`).send({});
    expect(r.status).toBe(200);
    expect(r.body.temporary_password).toMatch(/^.{14,}$/);
    expect((await v.get("/api/me")).status).toBe(401);
    expect((await browser().post("/api/auth/login").send({ email: v.user.email, password: "another pass" })).status).toBe(401);
    expect((await browser().post("/api/auth/login").send({ email: v.user.email, password: r.body.temporary_password })).status).toBe(200);
    expect(JSON.stringify(await adminLog())).not.toContain(r.body.temporary_password);
    expect((await admin.post("/users/u_000000000000/reset-password").send({})).status).toBe(404);
  });

  it("changes a person's role in an organization, and removes them; the last admin is kept", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    const v = await member(a);
    expect((await admin.patch(`/orgs/${orgOf(a)}/members/${v.user.id}`).send({ role: "manager" })).body.role).toBe("manager");
    expect((await v.get("/api/me")).body.role).toBe("manager");
    expect((await admin.patch(`/orgs/${orgOf(a)}/members/${v.user.id}`).send({ role: "admin" })).status).toBe(200);
    expect((await admin.patch(`/orgs/${orgOf(a)}/members/${v.user.id}`).send({ role: "manager" })).status).toBe(200);
    expect((await admin.patch(`/orgs/${orgOf(a)}/members/${v.user.id}`).send({ role: "emperor" })).status).toBe(400);
    expect((await admin.patch(`/orgs/${orgOf(a)}/members/${a.user.id}`).send({ role: "viewer" })).status).toBe(400);
    expect((await admin.delete(`/orgs/${orgOf(a)}/members/${a.user.id}`)).status).toBe(400);
    expect((await admin.delete(`/orgs/${orgOf(a)}/members/${v.user.id}`)).status).toBe(200);
    expect((await v.get("/api/me")).status).toBe(401);
    expect((await admin.delete(`/orgs/${orgOf(a)}/members/u_000000000000`)).status).toBe(404);
  });

  it("changes an organization's own call rules for it", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "start" });
    const r = await admin.patch(`/orgs/${orgOf(a)}/settings`).send({ max_minutes: 7, call_window: { enabled: true, start: "10:00", end: "20:00", timezone: "Asia/Kolkata" } });
    expect(r.status).toBe(200);
    const mine = (await a.get("/api/org/settings")).body;
    expect(mine).toMatchObject({ max_minutes: 7, call_window: { enabled: true, start: "10:00", end: "20:00" } });
    expect((await admin.patch(`/orgs/${orgOf(a)}/settings`).send({ max_minutes: 999 })).status).toBe(400);
    expect((await admin.patch(`/orgs/${orgOf(a)}/settings`).send({ webhook_url: "http://169.254.169.254/" })).status).toBe(400);
  });
});

describe("opening the Studio as a person, for support", () => {
  const consume = (token) => browser().post("/api/auth/support-signin").send({ token });

  it("hands over a one-use link that expires in a minute; the Studio shows it is Kaho support; it is recorded on both sides", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "start" });
    const r = await admin.post(`/orgs/${orgOf(a)}/impersonate`).send({ user_id: a.user.id });
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^http:\/\/localhost:5173\/support#token=[A-Za-z0-9_-]{30,}$/);
    const token = r.body.url.split("token=")[1];
    const studio = browser();
    const opened = await studio.post("/api/auth/support-signin").send({ token });
    expect(opened.status).toBe(200);
    expect(opened.body.email).toBe(a.user.email);
    const me = (await studio.get("/api/me")).body;
    expect(me.support).toBe(true);
    expect(JSON.stringify(me)).not.toContain(admin.admin.email);
    expect((await consume(token)).status).toBe(401); // once
    expect((await notes(a)).some((t) => /Kaho support/i.test(t))).toBe(true);
    const log = await adminLog();
    expect(log.some((l) => l.action === "support.open" && l.org_id === orgOf(a) && l.admin_email === admin.admin.email)).toBe(true);
    // what the person's own audit log shows
    const audit = (await a.get("/api/audit?page=1&per_page=50")).body.entries;
    expect(audit.some((e) => /Kaho support/.test(e.detail) || /Kaho support/.test(e.actor))).toBe(true);
  });

  it("an old, made-up or malformed link opens nothing", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    const r = await admin.post(`/orgs/${orgOf(a)}/impersonate`).send({ user_id: a.user.id });
    const token = r.body.url.split("token=")[1];
    await db.query("UPDATE impersonations SET expires_at = now() - interval '1 second'");
    expect((await consume(token)).status).toBe(401);
    for (const bad of ["", "x", "a".repeat(500), null, ["a"], { t: 1 }, undefined]) {
      expect((await browser().post("/api/auth/support-signin").send(bad === undefined ? {} : { token: bad })).status, JSON.stringify(bad)).toBe(401);
    }
  });

  it("only for a person who is in that organization and whose account is on", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha"); const b = await team("Beta");
    expect((await admin.post(`/orgs/${orgOf(a)}/impersonate`).send({ user_id: b.user.id })).status).toBe(404);
    await db.query("UPDATE users SET disabled_at = now() WHERE id = $1", [a.user.id]);
    expect((await admin.post(`/orgs/${orgOf(a)}/impersonate`).send({ user_id: a.user.id })).status).toBe(400);
    expect((await admin.post(`/orgs/${orgOf(a)}/impersonate`).send({})).status).toBe(400);
  });

  it("a support session cannot change the person's password or sign their other browsers out, and is short", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    const r = await admin.post(`/orgs/${orgOf(a)}/impersonate`).send({ user_id: a.user.id });
    const studio = browser();
    await studio.post("/api/auth/support-signin").send({ token: r.body.url.split("token=")[1] });
    expect((await studio.post("/api/auth/password").send({ current: "correct horse", new: "a new password" })).status).toBe(403);
    expect((await studio.post("/api/auth/logout-others")).status).toBe(403);
    const s = (await db.query("SELECT impersonated_by, expires_at FROM sessions WHERE impersonated_by IS NOT NULL")).rows[0];
    expect(s.impersonated_by).toBe(admin.admin.email);
    expect(s.expires_at.getTime() - Date.now()).toBeLessThan(2.1 * 3600 * 1000);
  });
});

describe("the admin record", () => {
  it("lists what every admin did, newest first, to whom, and cannot be edited", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "start" });
    await admin.post(`/orgs/${orgOf(a)}/minutes`).send({ minutes: 10, note: "x" });
    const r = (await admin.get("/audit?page=1&per_page=10")).body;
    expect(r.entries[0]).toMatchObject({ action: "minutes.adjust", org_id: orgOf(a) });
    expect(r.entries.map((e) => e.action)).toContain("plan.assign");
    expect(r.entries.every((e) => e.admin_email === admin.admin.email)).toBe(true);
    await expect(db.query("SET LOCAL ROLE kaho_app; UPDATE admin_audit SET detail = 'x'")).rejects.toThrow();
  });

  it("records a refused attempt on someone else's sign-in nowhere it could be forged: a sign-in is an event too", async () => {
    await signedInAdmin();
    const log = await adminLog();
    expect(log.some((l) => l.action === "auth.signup")).toBe(true);
    await adminBrowser().post("/auth/login").send({ email: AYUSHI, password: "nope nope nope nope" });
    expect((await adminLog()).some((l) => l.action === "auth.login_failed")).toBe(true);
  });
});

describe("hostile input", () => {
  it("answers 4xx, never 500, to odd ids, bodies and queries on every admin route", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    const org = orgOf(a);
    const calls = [
      ["get", "/orgs?page=-1"], ["get", "/orgs?per_page=abc"], ["get", "/orgs?q=%00"], ["get", "/users?q=%00"], ["get", "/topups?status=zzz"],
      ["get", "/audit?page=1e99"], ["get", "/audit?per_page=999"], ["post", `/orgs/${org}/plan`, { plan_id: ["start"] }],
      ["post", `/orgs/${org}/plan`, { plan_id: "start", terms: "no" }], ["post", `/orgs/${org}/plan`, { plan_id: "start", period_end: "yesterday" }],
      ["post", `/orgs/${org}/minutes`, { minutes: Number.MAX_SAFE_INTEGER }], ["post", `/orgs/${org}/status`, {}], ["patch", `/orgs/${org}`, {}],
      ["post", `/users/${a.user.id}/reset-password`, { x: 1 }], ["post", "/topups/tp_zzzzzzzzzzzz/approve", {}], ["patch", "/plans/start", { sort: "a" }],
    ];
    for (const [method, path, body] of calls) {
      const r = await admin[method](path).send(body ?? {});
      expect(r.status, `${method} ${path}`).toBeLessThan(500);
    }
  });

  it("every state-changing route needs a JSON body and a matching origin", async () => {
    const admin = await signedInAdmin();
    const cookie = admin.cookie;
    for (const path of ["/orgs/org_000000000000/minutes", "/topups/tp_000000000000/approve"]) {
      const forged = await request(app).post(`/api/admin${path}`).set("Host", "localhost:5174").set("Origin", "https://evil.example")
        .set("Cookie", cookie).send({ minutes: 5 });
      expect(forged.status, path).toBe(403);
    }
  });
});

describe("what the admin sees must not carry secrets", () => {
  it("never returns a provider key, a stored hash or a session token anywhere in an organization's detail", async () => {
    const admin = await signedInAdmin();
    const a = await team("Alpha");
    await admin.post(`/orgs/${orgOf(a)}/plan`).send({ plan_id: "start" });
    await a.post("/api/numbers").send({ provider: "plivo", number: "+918065520552", credentials: { auth_id: "MAID123456", auth_token: "super-secret-token-value" } });
    const d = JSON.stringify((await admin.get(`/orgs/${orgOf(a)}`)).body);
    expect(d).not.toContain("super-secret-token-value");
    expect(d).not.toMatch(/token_hash|"salt"|"hash"/);
  });
});

void internal;
