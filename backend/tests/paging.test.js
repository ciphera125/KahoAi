import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, owner } from "./helpers.js";

beforeEach(freshDb);

describe("the contact list is paged and searchable on the server", () => {
  async function many(b, n) {
    for (let i = 0; i < n; i++) {
      await b.post("/api/contacts").send({ name: `Person ${String(i).padStart(3, "0")}`, numbers: [`90000${String(i).padStart(5, "0")}`] });
    }
  }

  it("returns one page at a time with a total, oldest first", async () => {
    const b = await owner();
    await many(b, 23);
    const p1 = await b.get("/api/contacts?page=1&per_page=10");
    expect(p1.body).toMatchObject({ total: 23, page: 1, per_page: 10 });
    expect(p1.body.contacts).toHaveLength(10);
    expect(p1.body.contacts[0].name).toBe("Person 000");
    expect((await b.get("/api/contacts?page=3&per_page=10")).body.contacts).toHaveLength(3);
    expect((await b.get("/api/contacts?per_page=7")).body.error).toBe("per_page must be one of 10, 20, 25, 50, 100");
  });

  it("searches by name, number and tag without loading everyone", async () => {
    const b = await owner();
    await many(b, 5);
    const tag = (await b.post("/api/tags").send({ name: "VIP", color: "plum" })).body;
    await b.post("/api/contacts").send({ name: "Zara Khan", numbers: ["9811122233"], tags: [tag.id] });
    expect((await b.get("/api/contacts?q=zara")).body.contacts.map((c) => c.name)).toEqual(["Zara Khan"]);
    expect((await b.get("/api/contacts?q=811122")).body.contacts.map((c) => c.name)).toEqual(["Zara Khan"]);
    expect((await b.get("/api/contacts?q=vip")).body.contacts.map((c) => c.name)).toEqual(["Zara Khan"]);
    expect((await b.get("/api/contacts?q=Person")).body.total).toBe(5);
    expect((await b.get("/api/contacts?q=nobody")).body).toMatchObject({ total: 0, contacts: [] });
  });

  it("treats a search like %_\\ as text, not SQL wildcards", async () => {
    const b = await owner();
    await b.post("/api/contacts").send({ name: "Real Name", numbers: ["9876543210"] });
    expect((await b.get("/api/contacts?q=%25")).body.total).toBe(0);
    expect((await b.get("/api/contacts?q=_")).body.total).toBe(0);
  });

  it("offers a small type-ahead lookup for the call form, never the whole list", async () => {
    const b = await owner();
    await many(b, 30);
    const dnc = (await b.post("/api/contacts").send({ name: "Do Not Ring", numbers: ["9123456789"] })).body;
    await b.patch(`/api/contacts/${dnc.id}`).send({ dnc: true });
    const r = await b.get("/api/contacts/lookup?q=Person");
    expect(r.body.length).toBeLessThanOrEqual(10);
    expect(r.body.every((x) => x.name.startsWith("Person"))).toBe(true);
    expect((await b.get("/api/contacts/lookup?q=Do Not Ring")).body).toEqual([]); // dnc excluded
    expect((await b.get("/api/contacts/lookup?q=")).body).toEqual([]);
  });
});
