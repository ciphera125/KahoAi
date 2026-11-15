// Plans, the lock until a plan is taken, the minute wallet, and what a plan limits.
// Billing is off for the suite as a whole; this file turns it on.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { db, freshDb, internal, line, member, owner, OURS } from "./helpers.js";
import { startFakes } from "./fakes.js";
import * as Billing from "../src/models/Billing.js";
import { runOnce } from "../src/services/bulkRunner.js";

let fakes, seq;
beforeAll(async () => { config.BILLING_ENFORCED = true; fakes = await startFakes(); });
afterAll(async () => { config.BILLING_ENFORCED = false; config.SUBSCRIPTION_AUTO_ACTIVATE = false; await fakes.close(); });
beforeEach(async () => {
  config.SUBSCRIPTION_AUTO_ACTIVATE = false;
  await freshDb();
  fakes.plivo.requests.length = 0;
  fakes.voice.requests.length = 0;
  seq = 0;
  fakes.plivo.reply = () => ({ status: 201, body: { request_uuid: `req-${String(++seq).padStart(4, "0")}-bill`, message: "call fired" } });
  fakes.voice.reply = { status: 200, body: '<Response><Stream bidirectional="true">wss://x/ws</Stream></Response>' };
});

const NOON = new Date("2026-10-25T06:30:00Z");
const dials = () => fakes.plivo.requests.filter((q) => q.method === "POST");
const rows = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ name: `Person ${start + i}`, number: `98765${String(start + i).padStart(5, "0")}` }));
const balance = async (org) => (await db.query("SELECT balance_minutes AS n FROM subscriptions WHERE org_id = $1", [org])).rows[0]?.n;
const live = (org, id, fields = {}) => db.query(
  `INSERT INTO calls (call_id, org_id, status, direction, started_at, has_transcript) VALUES ($1, $2, 'ringing', 'outbound', now(), $3)`,
  [id, org, fields.talking ?? true]);

/** An organization that has taken a plan (as an admin would activate it). */
let people = 0;
async function subscribed(planId = "growth", fields = {}) {
  const k = ++people;
  const b = await owner({ email: `person${k}@acme.in`, organization: `Acme ${k}` });
  await Billing.assign(b.user.org_id, { planId, adminEmail: "test@kaho.in", ...fields });
  return b;
}
async function dialSetup(b) {
  const n = (await b.post("/api/numbers").send({ provider: "plivo", number: OURS, credentials: { auth_id: "MAID123", auth_token: "plivo-token" } })).body;
  const a = (await b.post("/api/agents").send({ name: "EMI reminder", prompt: "You are Riya." })).body;
  return { n, a };
}
const place = (b, n) => b.post("/api/calls").send({ from_id: n.id, to: "9876543210", consent: true });

describe("the rate card", () => {
  it("lists the four plans of 2026-11-15, in order, with the terms printed on it", async () => {
    const b = await owner();
    const r = await b.get("/api/plans");
    expect(r.status).toBe(200);
    expect(r.body.map((p) => p.id)).toEqual(["start", "growth", "scale", "enterprise"]);
    const by = Object.fromEntries(r.body.map((p) => [p.id, p]));
    expect(by.start).toMatchObject({ name: "Start", price_paise: 549900, minutes_included: 1100, approx_calls: 440, rate_paise: 500,
      extra_paise: 550, simultaneous: 2, log_days: 30, support: "Email", languages: "Hindi + English", highlighted: false, custom: false });
    expect(by.growth).toMatchObject({ price_paise: 899900, minutes_included: 2000, approx_calls: 800, rate_paise: 450, extra_paise: 500,
      simultaneous: 5, log_days: 90, support: "Email + priority chat", highlighted: true });
    expect(by.scale).toMatchObject({ price_paise: 2199900, minutes_included: 5500, approx_calls: 2200, rate_paise: 400, extra_paise: 450,
      simultaneous: 10, log_days: 365, support: "Priority + onboarding call" });
    expect(by.enterprise).toMatchObject({ custom: true, price_paise: null, minutes_included: null, rate_paise: 375, rate_is_from: true,
      extra_paise: null, simultaneous: null, support: "Dedicated manager" });
  });

  it("is only shown to someone who is signed in", async () => {
    const { browser } = await import("./helpers.js");
    expect((await browser().get("/api/plans")).status).toBe(401);
  });
});

describe("no plan, no Studio", () => {
  it("a new organization is locked: it can see who it is and choose a plan, and nothing else", async () => {
    const b = await owner();
    const me = await b.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.body.billing).toMatchObject({ locked: true, reason: "subscription_required", status: null, minutes_left: 0 });
    for (const path of ["/api/agents", "/api/calls", "/api/contacts", "/api/dashboard", "/api/numbers", "/api/bulk-calls", "/api/tasks"]) {
      const r = await b.get(path);
      expect(r.status, path).toBe(402);
      expect(r.body.code, path).toBe("subscription_required");
      expect(r.body.error, path).toMatch(/plan/i);
    }
    for (const path of ["/api/plans", "/api/billing", "/api/orgs", "/api/notifications", "/api/billing/summary"]) {
      expect((await b.get(path)).status, path).toBe(200);
    }
    expect((await b.post("/api/agents").send({ name: "x", prompt: "y" })).status).toBe(402);
  });

  it("choosing a plan is not paying for it: the organization stays locked until the plan is active", async () => {
    const b = await owner();
    const r = await b.post("/api/billing/subscribe").send({ plan_id: "growth" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "pending", plan_id: "growth", locked: true, reason: "subscription_pending" });
    expect((await b.get("/api/agents")).status).toBe(402);
    expect((await b.get("/api/agents")).body.code).toBe("subscription_pending");
    const sub = (await db.query("SELECT status, balance_minutes, terms FROM subscriptions WHERE org_id = $1", [b.user.org_id])).rows[0];
    expect(sub.status).toBe("pending");
    expect(sub.balance_minutes).toBe(0); // no minutes until it is paid for
    expect(sub.terms).toMatchObject({ price_paise: 899900, minutes_included: 2000, simultaneous: 5 });
  });

  it("can change its mind before paying; an unknown, hidden or non-text plan is refused", async () => {
    const b = await owner();
    await b.post("/api/billing/subscribe").send({ plan_id: "start" });
    expect((await b.post("/api/billing/subscribe").send({ plan_id: "scale" })).body.plan_id).toBe("scale");
    for (const bad of ["nope", "", null, 7, ["start"], { id: "start" }, undefined]) {
      const r = await b.post("/api/billing/subscribe").send(bad === undefined ? {} : { plan_id: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    await db.query("UPDATE plans SET active = false WHERE id = 'start'");
    expect((await b.post("/api/billing/subscribe").send({ plan_id: "start" })).status).toBe(400);
  });

  it("only someone who manages billing can choose a plan; others can look", async () => {
    const b = await owner();
    const viewer = await member(b);
    expect((await viewer.post("/api/billing/subscribe").send({ plan_id: "start" })).status).toBe(403);
    expect((await viewer.get("/api/billing/summary")).status).toBe(200);
  });

  it("an active plan opens the Studio and gives the plan's minutes", async () => {
    const b = await owner();
    await Billing.assign(b.user.org_id, { planId: "growth", adminEmail: "a@kaho.in" });
    expect((await b.get("/api/agents")).status).toBe(200);
    const me = (await b.get("/api/me")).body.billing;
    expect(me).toMatchObject({ locked: false, status: "active", plan_id: "growth", plan_name: "Growth", minutes_left: 2000, unmetered: false });
    expect(await balance(b.user.org_id)).toBe(2000);
  });

  it("a plan that lapses, or is suspended, locks the organization again with its own reason", async () => {
    const b = await subscribed("start");
    await db.query("UPDATE subscriptions SET status = 'suspended' WHERE org_id = $1", [b.user.org_id]);
    const r = await b.get("/api/agents");
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("subscription_suspended");
    await db.query("UPDATE subscriptions SET status = 'expired' WHERE org_id = $1", [b.user.org_id]);
    expect((await b.get("/api/agents")).body.code).toBe("subscription_expired");
  });

  it("starts the plan at once when the owner has switched on automatic activation, but never Enterprise", async () => {
    config.SUBSCRIPTION_AUTO_ACTIVATE = true;
    const b = await owner();
    const r = await b.post("/api/billing/subscribe").send({ plan_id: "start" });
    expect(r.body).toMatchObject({ status: "active", locked: false, minutes_left: 1100 });
    const c = await owner({ email: "x@other.in", organization: "Other" });
    const e = await c.post("/api/billing/subscribe").send({ plan_id: "enterprise" });
    expect(e.body).toMatchObject({ status: "pending", locked: true });
  });

  it("keeps the terms it was sold: editing the plan later does not change an active customer", async () => {
    const b = await subscribed("start");
    await db.query("UPDATE plans SET minutes_included = 9999, simultaneous = 9, extra_paise = 1 WHERE id = 'start'");
    const s = (await b.get("/api/billing")).body;
    expect(s.terms).toMatchObject({ minutes_included: 1100, simultaneous: 2, extra_paise: 550 });
  });

  it("existing organizations were grandfathered: active, no minute limit", async () => {
    const b = await owner();
    // what migration 028 did for an organization that already existed
    await db.query(`INSERT INTO subscriptions (org_id, plan_id, status, terms, unmetered) VALUES ($1, 'enterprise', 'active', '{"simultaneous":10}', true)`, [b.user.org_id]);
    expect((await b.get("/api/agents")).status).toBe(200);
    expect((await b.get("/api/me")).body.billing).toMatchObject({ locked: false, unmetered: true });
  });
});

describe("the minute wallet", () => {
  const T = (s) => `2026-11-08T10:00:${String(s).padStart(2, "0")}.000Z`;
  const outcome = (id, secs, extra = {}) => internal("put", `/internal/v1/calls/${id}`)
    .send({ status: "answered", peer: "+919876543210", ours: OURS, direction: "outbound", duration_secs: secs, ...extra });

  it("charges a call to its next whole minute: 61 seconds is 2 minutes, 60 is 1", async () => {
    const b = await subscribed("growth");
    await line(b);
    await outcome("call-aaaa-0001", 61);
    expect(await balance(b.user.org_id)).toBe(1998);
    await outcome("call-aaaa-0002", 60);
    expect(await balance(b.user.org_id)).toBe(1997);
    await outcome("call-aaaa-0003", 1);
    expect(await balance(b.user.org_id)).toBe(1996);
  });

  it("charges nothing for a call that never connected", async () => {
    const b = await subscribed("growth");
    await line(b);
    await outcome("call-aaaa-0004", 0, { status: "no_answer" });
    await outcome("call-aaaa-0005", null, { status: "ringing" });
    expect(await balance(b.user.org_id)).toBe(2000);
  });

  it("a call reported twice, or reported again with a corrected length, is charged once", async () => {
    const b = await subscribed("growth");
    await line(b);
    await outcome("call-bbbb-0001", 125); // 3 minutes
    await outcome("call-bbbb-0001", 125);
    expect(await balance(b.user.org_id)).toBe(1997);
    await outcome("call-bbbb-0001", 40); // corrected to 1 minute
    expect(await balance(b.user.org_id)).toBe(1999);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM minute_ledger WHERE call_id = 'call-bbbb-0001'");
    expect(rows[0].n).toBe(1);
  });

  it("also charges from the call's own start and end lines", async () => {
    const b = await subscribed("growth");
    await line(b);
    await internal("put", "/internal/v1/calls/call-cccc-0001").send({ status: "answered", peer: "+919876543210", ours: OURS });
    await internal("post", "/internal/v1/calls/call-cccc-0001/events").send({ events: [
      { event: "call_start", at: T(0) }, { event: "call_end", at: "2026-11-08T10:02:30.000Z" }] });
    expect(await balance(b.user.org_id)).toBe(1997); // 150 seconds
  });

  it("is never charged to an unmetered (grandfathered) organization, and never to another organization", async () => {
    const b = await owner();
    await db.query(`INSERT INTO subscriptions (org_id, plan_id, status, terms, unmetered) VALUES ($1, 'enterprise', 'active', '{"simultaneous":10}', true)`, [b.user.org_id]);
    await line(b);
    await outcome("call-dddd-0001", 600);
    expect(await balance(b.user.org_id)).toBe(0);
    const other = await subscribed("start");
    expect(await balance(other.user.org_id)).toBe(1100);
  });

  it("keeps the stored balance equal to what the ledger adds up to", async () => {
    const b = await subscribed("growth");
    await line(b);
    await outcome("call-eeee-0001", 300);
    await outcome("call-eeee-0002", 61);
    await Billing.adjust(b.user.org_id, 40, { actor: "admin", note: "goodwill" });
    const { rows } = await db.query(`SELECT s.balance_minutes AS stored, (SELECT sum(minutes) FROM minute_ledger l WHERE l.org_id = s.org_id)::int AS summed
      FROM subscriptions s WHERE s.org_id = $1`, [b.user.org_id]);
    expect(rows[0].stored).toBe(rows[0].summed);
    expect(rows[0].stored).toBe(2000 - 5 - 2 + 40);
  });

  it("a money entry can never be rewritten, only a call's own usage line", async () => {
    const b = await subscribed("growth");
    await expect(db.query("UPDATE minute_ledger SET minutes = 999999 WHERE kind = 'plan' AND org_id = $1", [b.user.org_id])).rejects.toThrow(/ledger/);
  });

  it("shows the person the ledger and what was used this period", async () => {
    const b = await subscribed("growth");
    await line(b);
    await outcome("call-ffff-0001", 125);
    const s = (await b.get("/api/billing")).body;
    expect(s.minutes_left).toBe(1997);
    expect(s.used_this_period).toBe(3);
    const l = (await b.get("/api/billing/ledger?page=1&per_page=10")).body;
    expect(l.total).toBe(2);
    expect(l.entries.map((e) => [e.kind, e.minutes])).toEqual([["usage", -3], ["plan", 2000]]);
  });
});

describe("what the plan allows when placing calls", () => {
  it("refuses a call with no minutes left, plainly, and says where to top up", async () => {
    const b = await subscribed("start");
    const { n } = await dialSetup(b);
    await Billing.adjust(b.user.org_id, -1100, { actor: "t", note: "used up" });
    const r = await place(b, n);
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("no_minutes");
    expect(r.body.error).toMatch(/no minutes left/i);
    expect(r.body.error).toMatch(/top up/i);
    expect(dials()).toHaveLength(0);
  });

  it("lets the call through while there are minutes", async () => {
    const b = await subscribed("start");
    const { n } = await dialSetup(b);
    const r = await place(b, n);
    expect(r.status).toBe(200);
    expect(dials()).toHaveLength(1);
  });

  it("refuses a call when the plan's simultaneous calls are already on the line", async () => {
    const b = await subscribed("start"); // 2 at once
    const { n } = await dialSetup(b);
    await live(b.user.org_id, "live-0000-0001");
    await live(b.user.org_id, "live-0000-0002");
    const r = await place(b, n);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("too_many_calls");
    expect(r.body.error).toMatch(/2 calls at once/);
    expect(dials()).toHaveLength(0);
  });

  it("does not count another organization's calls, or ones that ended, or ones that never connected", async () => {
    const b = await subscribed("start");
    const { n } = await dialSetup(b);
    const other = await subscribed("start");
    await live(other.user.org_id, "live-0000-0003");
    await live(other.user.org_id, "live-0000-0004");
    await db.query(`INSERT INTO calls (call_id, org_id, status, started_at, ended_at, has_transcript) VALUES ('live-0000-0005', $1, 'answered', now(), now(), true)`, [b.user.org_id]);
    await db.query(`INSERT INTO calls (call_id, org_id, status, started_at, has_transcript) VALUES ('live-0000-0006', $1, 'ringing', now() - interval '10 minutes', false)`, [b.user.org_id]);
    expect((await place(b, n)).status).toBe(200);
  });

  it("refuses calls when the plan has lapsed, and when a plan was never taken", async () => {
    const b = await subscribed("start");
    const { n } = await dialSetup(b);
    await db.query("UPDATE subscriptions SET status = 'expired' WHERE org_id = $1", [b.user.org_id]);
    expect((await place(b, n)).status).toBe(402);
  });

  it("the check on placing a call refuses a plan that is not open even when nothing else stood in front of it", async () => {
    // The route-level gate normally answers first; anything that reaches call placement some other way must be refused here.
    const b = await subscribed("start");
    for (const [status, code] of [["pending", "subscription_pending"], ["suspended", "subscription_suspended"], ["expired", "subscription_expired"], ["cancelled", "subscription_required"]]) {
      await db.query("UPDATE subscriptions SET status = $2 WHERE org_id = $1", [b.user.org_id, status]);
      await expect(Billing.assertCanCall(b.user.org_id), status).rejects.toMatchObject({ status: 402, code });
    }
    await db.query("DELETE FROM subscriptions WHERE org_id = $1", [b.user.org_id]);
    await expect(Billing.assertCanCall(b.user.org_id)).rejects.toMatchObject({ code: "subscription_required" });
  });

  it("an unmetered organization is not limited by minutes", async () => {
    const b = await owner();
    await db.query(`INSERT INTO subscriptions (org_id, plan_id, status, terms, unmetered) VALUES ($1, 'enterprise', 'active', '{"simultaneous":10}', true)`, [b.user.org_id]);
    const { n } = await dialSetup(b);
    expect((await place(b, n)).status).toBe(200);
  });
});

describe("bulk calls under a plan", () => {
  const start = (b, body) => b.post("/api/bulk-calls").send({ consent: true, parallel: 2, ...body });

  it("cannot be set to more calls at once than the plan allows", async () => {
    const b = await subscribed("start"); // 2 at once
    const { n, a } = await dialSetup(b);
    const r = await start(b, { agent_id: a.id, from_id: n.id, rows: rows(5), parallel: 3 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/plan allows 2/i);
    expect((await start(b, { agent_id: a.id, from_id: n.id, rows: rows(5), parallel: 2 })).status).toBe(200);
  });

  it("never has more on the line than the plan allows, even if the plan was lowered afterwards", async () => {
    const b = await subscribed("growth", { terms: { simultaneous: 4 } });
    const { n, a } = await dialSetup(b);
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(10), parallel: 4 });
    await Billing.setTerms(b.user.org_id, { simultaneous: 2 }, { adminEmail: "t@kaho.in" });
    await runOnce({ now: NOON });
    expect(dials()).toHaveLength(2);
  });

  it("calls already on the line, placed by hand, count against the plan's limit", async () => {
    const b = await subscribed("start"); // 2 at once
    const { n, a } = await dialSetup(b);
    await live(b.user.org_id, "live-1111-0001");
    await start(b, { agent_id: a.id, from_id: n.id, rows: rows(10), parallel: 2 });
    await runOnce({ now: NOON });
    expect(dials()).toHaveLength(1);
  });

  it("pauses with the reason, and tells the team, when the minutes run out; nothing is dialled", async () => {
    const b = await subscribed("start");
    const { n, a } = await dialSetup(b);
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(6), parallel: 2 })).body;
    await Billing.adjust(b.user.org_id, -1100, { actor: "t", note: "used up" });
    await runOnce({ now: NOON });
    expect(dials()).toHaveLength(0);
    const got = (await b.get(`/api/bulk-calls/${run.id}`)).body;
    expect(got.status).toBe("paused");
    expect(got.waiting).toMatch(/no minutes left/i);
    const notes = (await b.get("/api/notifications")).body.items.map((i) => i.text);
    expect(notes.some((t) => /paused/.test(t) && /minutes/.test(t))).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM bulk_items WHERE status = 'queued'")).rows[0].n).toBe(6); // nobody was lost
  });

  it("pauses when the plan is suspended", async () => {
    const b = await subscribed("start");
    const { n, a } = await dialSetup(b);
    const run = (await start(b, { agent_id: a.id, from_id: n.id, rows: rows(6), parallel: 2 })).body;
    await db.query("UPDATE subscriptions SET status = 'suspended' WHERE org_id = $1", [b.user.org_id]);
    await runOnce({ now: NOON });
    expect(dials()).toHaveLength(0);
    expect((await db.query("SELECT status FROM bulk_runs WHERE id = $1", [run.id])).rows[0].status).toBe("paused");
  });
});

describe("a plan runs for a month", () => {
  it("expires an active plan whose month is over, and says so to the team", async () => {
    const b = await subscribed("start");
    await db.query("UPDATE subscriptions SET period_end = now() - interval '1 hour' WHERE org_id = $1", [b.user.org_id]);
    const out = await Billing.expireDue(new Date());
    expect(out.expired).toEqual([b.user.org_id]);
    expect((await db.query("SELECT status FROM subscriptions WHERE org_id = $1", [b.user.org_id])).rows[0].status).toBe("expired");
    expect((await b.get("/api/notifications")).body.items.some((i) => /ended/i.test(i.text) && /plan/i.test(i.text))).toBe(true);
    expect((await Billing.expireDue(new Date())).expired).toEqual([]); // once
  });

  it("never expires an unmetered organization, and warns three days before the end, once", async () => {
    const b = await owner();
    await db.query(`INSERT INTO subscriptions (org_id, plan_id, status, terms, unmetered, period_end) VALUES ($1, 'enterprise', 'active', '{}', true, now() - interval '5 days')`, [b.user.org_id]);
    expect((await Billing.expireDue(new Date())).expired).toEqual([]);

    const c = await subscribed("start");
    await db.query("UPDATE subscriptions SET period_end = now() + interval '2 days' WHERE org_id = $1", [c.user.org_id]);
    expect((await Billing.expireDue(new Date())).reminded).toEqual([c.user.org_id]);
    expect((await Billing.expireDue(new Date())).reminded).toEqual([]);
    expect((await c.get("/api/notifications")).body.items.some((i) => /renews|ends/i.test(i.text))).toBe(true);
  });

  it("renewing gives the next month's minutes and moves the end of the period on", async () => {
    const b = await subscribed("start");
    await db.query("UPDATE subscriptions SET period_end = now() - interval '1 hour', status = 'expired' WHERE org_id = $1", [b.user.org_id]);
    await Billing.renew(b.user.org_id, { adminEmail: "a@kaho.in" });
    const s = (await db.query("SELECT status, balance_minutes, period_end FROM subscriptions WHERE org_id = $1", [b.user.org_id])).rows[0];
    expect(s.status).toBe("active");
    expect(s.balance_minutes).toBe(2200); // unused minutes carry over
    expect(s.period_end.getTime()).toBeGreaterThan(Date.now() + 27 * 86400000);
  });
});

describe("moving an organization that had no limit onto a real plan", () => {
  // Every organization that existed before plans was grandfathered as "no limit": active, no minutes, no month. Putting
  // one on Scale must give it Scale's minutes and start its month; it used to be left metered with a balance of nothing,
  // so its calls were refused (found 2026-11-15 on the owner's own organization, one minute after the admin site opened).
  const grandfathered = async () => {
    const b = await owner();
    await db.query(`INSERT INTO subscriptions (org_id, plan_id, status, terms, unmetered) VALUES ($1, 'enterprise', 'active', '{"simultaneous":10}', true)`, [b.user.org_id]);
    return b;
  };

  it("starts the plan: its minutes and a month, with nothing else asked for", async () => {
    const b = await grandfathered();
    const sub = await Billing.assign(b.user.org_id, { planId: "scale", adminEmail: "a@kaho.in" });
    expect(sub).toMatchObject({ plan_id: "scale", status: "active", unmetered: false, balance_minutes: 5500 });
    expect(new Date(sub.period_end).getTime()).toBeGreaterThan(Date.now() + 27 * 86400000);
    expect((await b.get("/api/me")).body.billing).toMatchObject({ locked: false, minutes_left: 5500 });
  });

  it("starts the month even if the admin chose not to add the minutes: a metered plan with no end date is never left behind", async () => {
    const b = await grandfathered();
    const sub = await Billing.assign(b.user.org_id, { planId: "growth", grantIncluded: false, adminEmail: "a@kaho.in" });
    expect(sub).toMatchObject({ status: "active", unmetered: false, balance_minutes: 0 });
    expect(sub.period_end).not.toBeNull();
  });

  it("an organization already on a metered plan keeps its balance and its month when its plan changes", async () => {
    const b = await subscribed("start");
    const before = await Billing.get(b.user.org_id);
    const after = await Billing.assign(b.user.org_id, { planId: "growth", adminEmail: "a@kaho.in" });
    expect(after.balance_minutes).toBe(before.balance_minutes); // no free monthly minutes for changing plan mid-month
    expect(after.period_end).toBe(before.period_end);
  });

  it("a metered plan that somehow has no end date is given one the next time it is assigned", async () => {
    const b = await subscribed("start");
    await db.query("UPDATE subscriptions SET period_end = NULL WHERE org_id = $1", [b.user.org_id]);
    const after = await Billing.assign(b.user.org_id, { planId: "start", grantIncluded: false, adminEmail: "a@kaho.in" });
    expect(after.period_end).not.toBeNull();
  });
});

describe("terms an admin can set are checked", () => {
  it("refuses nonsense and unknown fields, and an Enterprise plan with its terms left empty", async () => {
    const b = await owner();
    const org = b.user.org_id;
    await expect(Billing.assign(org, { planId: "start", terms: { simultaneous: 0 }, adminEmail: "a@k" })).rejects.toThrow(/simultaneous/);
    await expect(Billing.assign(org, { planId: "start", terms: { extra_paise: -1 }, adminEmail: "a@k" })).rejects.toThrow(/extra/);
    await expect(Billing.assign(org, { planId: "start", terms: { rate_paise: 1.5 }, adminEmail: "a@k" })).rejects.toThrow(/rate/);
    await expect(Billing.assign(org, { planId: "start", terms: { evil: 1 }, adminEmail: "a@k" })).rejects.toThrow(/unknown/);
    await expect(Billing.assign(org, { planId: "enterprise", adminEmail: "a@k" })).rejects.toThrow(/terms/);
    await expect(Billing.assign(org, { planId: "nope", adminEmail: "a@k" })).rejects.toThrow(/plan/);
    const ok = await Billing.assign(org, { planId: "enterprise", adminEmail: "a@k",
      terms: { price_paise: 5000000, minutes_included: 10000, rate_paise: 375, extra_paise: 420, simultaneous: 20, log_days: 365, support: "Dedicated manager" } });
    expect(ok.status).toBe("active");
    expect(await balance(org)).toBe(10000);
  });
});

describe("the timer that turns the month over", () => {
  it("ends a lapsed plan and warns an ending one, under the same lock as the other runners", async () => {
    const { runLocked } = await import("../src/services/billingRunner.js");
    const lapsed = await subscribed("start");
    const ending = await subscribed("start");
    await db.query("UPDATE subscriptions SET period_end = now() - interval '1 hour' WHERE org_id = $1", [lapsed.user.org_id]);
    await db.query("UPDATE subscriptions SET period_end = now() + interval '2 days' WHERE org_id = $1", [ending.user.org_id]);
    const r = await runLocked();
    expect(r.expired).toEqual([lapsed.user.org_id]);
    expect(r.reminded).toEqual([ending.user.org_id]);
    expect((await lapsed.get("/api/agents")).body.code).toBe("subscription_expired");
    expect((await ending.get("/api/agents")).status).toBe(200);
  });

  it("a lapsed plan is locked even before the timer has run", async () => {
    const b = await subscribed("start");
    await db.query("UPDATE subscriptions SET period_end = now() - interval '1 minute' WHERE org_id = $1", [b.user.org_id]);
    const r = await b.get("/api/agents");
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("subscription_expired");
  });
});
