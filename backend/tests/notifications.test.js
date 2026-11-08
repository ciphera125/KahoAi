import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, owner } from "./helpers.js";

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
