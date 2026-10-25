import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, internal, member, owner, line, OURS } from "./helpers.js";

beforeEach(freshDb);

describe("contacts", () => {
  it("creates, lists, renames and deletes a contact", async () => {
    const b = await owner();
    await line(b);
    const c = (await b.post("/api/contacts").send({ name: "  Asha   Rao ", numbers: ["98765 43210", "+919876543210", "08065520552"] })).body;
    expect(c).toMatchObject({ name: "Asha Rao", tags: [], dnc: false });
    expect(c.numbers.map((n) => n.number)).toEqual(["+919876543210", "+918065520552"]);
    const list = (await b.get("/api/contacts")).body.contacts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Asha Rao", call_count: 0, last_call: null, dnc: false });
    expect((await b.patch(`/api/contacts/${c.id}`).send({ name: "Asha R" })).body.name).toBe("Asha R");
    expect((await b.delete(`/api/contacts/${c.id}`)).body).toEqual({ deleted: c.id });
    expect((await b.delete(`/api/contacts/${c.id}`)).status).toBe(404);
  });

  it("needs a name and real numbers, and may start without a number", async () => {
    const b = await owner();
    await line(b);
    expect((await b.post("/api/contacts").send({ name: "" })).body.error).toBe("the name is empty");
    expect((await b.post("/api/contacts").send({ name: "x".repeat(81) })).body.error).toBe("the name is over 80 characters");
    expect((await b.post("/api/contacts").send({ name: "A", numbers: ["12"] })).body.error).toBe("'12' is not a phone number");
    expect((await b.post("/api/contacts").send({ name: "A", numbers: "9876543210" })).status).toBe(400);
    expect((await b.post("/api/contacts").send({ name: "No number" })).body.numbers).toEqual([]);
  });

  it("adds, edits and deletes numbers, with no duplicates on a contact", async () => {
    const b = await owner();
    await line(b);
    const c = (await b.post("/api/contacts").send({ name: "A", numbers: ["9876543210"] })).body;
    const n = (await b.post(`/api/contacts/${c.id}/numbers`).send({ number: "9876500000" })).body;
    expect(n.number).toBe("+919876500000");
    expect((await b.post(`/api/contacts/${c.id}/numbers`).send({ number: "9876543210" })).body.error)
      .toBe("+919876543210 is already on this contact");
    expect((await b.patch(`/api/contacts/${c.id}/numbers/${n.id}`).send({ number: "9876543210" })).body.error)
      .toBe("+919876543210 is already on this contact");
    expect((await b.patch(`/api/contacts/${c.id}/numbers/${n.id}`).send({ number: "9000000001" })).body.number).toBe("+919000000001");
    expect((await b.delete(`/api/contacts/${c.id}/numbers/${n.id}`)).body).toEqual({ deleted: n.id });
    expect((await b.delete(`/api/contacts/${c.id}/numbers/${n.id}`)).status).toBe(404);
  });

  it("creates, edits, assigns and deletes tags, from the palette only", async () => {
    const b = await owner();
    await line(b);
    const t = (await b.post("/api/tags").send({ name: "EMI due", color: "plum" })).body;
    expect(t).toMatchObject({ name: "EMI due", color: "plum" });
    expect((await b.post("/api/tags").send({ name: "emi DUE", color: "teal" })).body.error).toBe("there is already a tag called emi DUE");
    expect((await b.post("/api/tags").send({ name: "X", color: "red" })).body.error)
      .toBe("colour must be one of marigold, plum, orchid, teal, silver, rose");
    const c = (await b.post("/api/contacts").send({ name: "A", numbers: ["9876543210"], tags: [t.id] })).body;
    expect(c.tags).toEqual([t.id]);
    expect((await b.patch(`/api/contacts/${c.id}`).send({ tags: ["nope"] })).body.error).toBe("unknown tag");
    const n = c.numbers[0];
    expect((await b.patch(`/api/contacts/${c.id}/numbers/${n.id}`).send({ tags: [t.id, t.id] })).body.tags).toEqual([t.id]);
    expect((await b.patch(`/api/tags/${t.id}`).send({ name: "Due" })).body).toMatchObject({ name: "Due", color: "plum" });
    expect((await b.delete(`/api/tags/${t.id}`)).body).toEqual({ deleted: t.id });
    const after = (await b.get("/api/contacts")).body.contacts[0];
    expect(after.tags).toEqual([]);
    expect(after.numbers[0].tags).toEqual([]);
    expect((await b.get("/api/tags")).body).toEqual([]);
  });

  it("marks a contact Do not call, matching any of its numbers", async () => {
    const b = await owner();
    await line(b);
    const c = (await b.post("/api/contacts").send({ name: "A", numbers: ["9876543210", "9000000000"] })).body;
    expect((await b.patch(`/api/contacts/${c.id}`).send({ dnc: true })).body.dnc).toBe(true);
    expect((await internal("get", "/internal/v1/dnc?number=09000000000")).body).toEqual({ dnc: true });
    expect((await internal("get", "/internal/v1/dnc?number=09000000000&from=%2B918888888888")).body).toEqual({ dnc: true });
    expect((await internal("get", "/internal/v1/dnc?number=9111111111")).body).toEqual({ dnc: false });
    expect((await b.patch(`/api/contacts/${c.id}`).send({ dnc: "yes" })).body.dnc).toBe(false);
  });

  it("bulk deletes, owner only, and members still do the daily work", async () => {
    const o = await owner();
    await line(o);
    const ids = [];
    for (const name of ["A", "B", "C"]) ids.push((await o.post("/api/contacts").send({ name })).body.id);
    const m = await member(o);
    expect((await m.post("/api/contacts/delete").send({ ids })).status).toBe(403);
    expect((await m.post("/api/contacts").send({ name: "D" })).status).toBe(200);
    expect((await o.post("/api/contacts/delete").send({ ids: [...ids.slice(0, 2), "nope"] })).body).toEqual({ deleted: 2 });
    expect((await o.get("/api/contacts")).body.contacts.map((c) => c.name)).toEqual(["C", "D"]);
  });

  it("shows each contact's last call and how many calls there were", async () => {
    const b = await owner();
    await line(b);
    const c = (await b.post("/api/contacts").send({ name: "A", numbers: ["9876543210"] })).body;
    await internal("put", "/internal/v1/calls/call-older").send({ ours: OURS, status: "no_answer", peer: "+919876543210", at: "2026-10-01T10:00:00Z" });
    await internal("put", "/internal/v1/calls/call-newer").send({ ours: OURS, status: "answered", peer: "+919876543210", at: "2026-10-02T10:00:00Z", duration_secs: 61 });
    const [row] = (await b.get("/api/contacts")).body.contacts;
    expect(row.call_count).toBe(2);
    expect(row.last_call).toMatchObject({ call_id: "call-newer", status: "answered", duration_secs: 61 });
    expect(row.id).toBe(c.id);
  });
});
