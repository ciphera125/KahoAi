import { beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, owner } from "./helpers.js";

beforeEach(freshDb);

describe("the notification feed", () => {
  it("says which ones are new, and nothing is new once they have been seen", async () => {
    const b = await owner();
    await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    let feed = (await b.get("/api/notifications")).body;
    expect(feed.unread).toBeGreaterThan(0);
    expect(feed.items.filter((n) => n.unread).length).toBe(feed.unread);
    await b.post("/api/notifications/seen");
    feed = (await b.get("/api/notifications")).body;
    expect(feed.unread).toBe(0);
    expect(feed.items.every((n) => n.unread === false)).toBe(true);
  });

  it("goes back further when asked, and refuses a silly amount", async () => {
    const b = await owner();
    for (let i = 0; i < 40; i++) await b.post("/api/tags").send({ name: `t${i}` });
    expect((await b.get("/api/notifications")).body.items.length).toBeLessThanOrEqual(30);
    expect((await b.get("/api/notifications?limit=100")).body.items.length).toBeGreaterThan(30);
    expect((await b.get("/api/notifications?limit=100000")).body.items.length).toBeLessThanOrEqual(200);
  });

  it("can point at every page the Studio has, so a click goes somewhere", async () => {
    const b = await owner();
    await b.post("/api/tasks").send({ title: "Pay EMI" });
    const key = await b.post("/api/api-keys").send({ name: "CRM" });
    expect(key.status).toBe(200);
    const views = (await b.get("/api/notifications")).body.items.map((n) => n.view);
    expect(views).toContain("settings");
  });
});

describe("scrolling through the feed", () => {
  const fill = async (b, n) => {
    const org = (await db.query("SELECT id FROM organizations LIMIT 1")).rows[0].id;
    const { add } = await import("../src/models/Activity.js");
    for (let i = 0; i < n; i++) {
      await add(org, "agent", `Change number ${i}`, { actor: "Asha" });
      await new Promise((r) => setTimeout(r, 2));
    }
  };

  it("gives a page at a time, newest first, and a place to carry on from", async () => {
    const b = await owner();
    await db.query("DELETE FROM activity"); // the sign-up's own notification
    await fill(b, 45);
    const first = (await b.get("/api/notifications?limit=20")).body;
    expect(first.items).toHaveLength(20);
    expect(first.items[0].text).toBe("Change number 44");
    expect(first.next).toEqual(expect.any(String));
    const second = (await b.get(`/api/notifications?limit=20&before=${encodeURIComponent(first.next)}`)).body;
    expect(second.items[0].text).toBe("Change number 24");
    expect(second.items).toHaveLength(20);
    const third = (await b.get(`/api/notifications?limit=20&before=${encodeURIComponent(second.next)}`)).body;
    expect(third.items).toHaveLength(5);
    expect(third.next).toBeNull();
  });

  it("never repeats or skips an item between pages, even when several share a moment", async () => {
    const b = await owner();
    await db.query("DELETE FROM activity"); // the sign-up's own notification
    const org = (await db.query("SELECT id FROM organizations LIMIT 1")).rows[0].id;
    for (let i = 0; i < 30; i++) await db.query("INSERT INTO activity (id, org_id, kind, text, at) VALUES ($1, $2, 'agent', $3, '2026-11-01T10:00:00Z')", [`x${String(i).padStart(2, "0")}`, org, `Same moment ${i}`]);
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const r = (await b.get(`/api/notifications?limit=7${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`)).body;
      seen.push(...r.items.map((x) => x.text));
      cursor = r.next;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it("keeps a long history, not just the last couple of hundred", async () => {
    const { MAX_ITEMS } = await import("../src/models/Activity.js");
    expect(MAX_ITEMS).toBeGreaterThanOrEqual(1000);
  });

  it("refuses a made-up place to carry on from, and an odd page size", async () => {
    const b = await owner();
    await db.query("DELETE FROM activity"); // the sign-up's own notification
    expect((await b.get("/api/notifications?before=nonsense")).status).toBe(400);
    expect((await b.get("/api/notifications?limit=0")).status).toBe(200); // falls back to a normal page
    expect((await b.get("/api/notifications?limit=500")).body.items.length).toBeLessThanOrEqual(50);
  });

  it("keeps the new count about everything, not just the page on screen", async () => {
    const b = await owner();
    await db.query("DELETE FROM activity"); // the sign-up's own notification
    await fill(b, 25);
    const r = (await b.get("/api/notifications?limit=10")).body;
    expect(r.items).toHaveLength(10);
    expect(r.unread).toBe(25);
  });
});
