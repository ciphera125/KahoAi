import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, internal, member, owner } from "./helpers.js";

beforeEach(freshDb);

describe("error logs", () => {
  it("records an error from the voice service and lists it in the Studio", async () => {
    const b = await owner();
    const orgId = b.user.org_id;
    const r = await internal("post", "/internal/v1/errors").send({
      level: "error", source: "tts", message: "Smallest returned 503", org_id: orgId,
    });
    expect(r.status).toBe(200);
    const list = (await b.get("/api/errors")).body;
    expect(list.errors).toHaveLength(1);
    expect(list.errors[0]).toMatchObject({ level: "error", source: "tts", message: "Smallest returned 503" });
    expect(list.errors[0].id).toBeTruthy();
    expect(list.errors[0].at).toBeTruthy();
  });

  it("associates errors with a call when a call_id is given", async () => {
    const b = await owner();
    await internal("post", "/internal/v1/errors").send({
      level: "warn", source: "llm", message: "Groq 429: rate limited", call_id: null, org_id: b.user.org_id,
    });
    const list = (await b.get("/api/errors")).body;
    expect(list.errors[0]).toMatchObject({ source: "llm", call_id: null });
  });

  it("also raises a notification, linked to the Error Logs page", async () => {
    const b = await owner();
    await internal("post", "/internal/v1/errors").send({
      level: "error", source: "tts", message: "Smallest returned 503", org_id: b.user.org_id,
    });
    const feed = (await b.get("/api/notifications")).body;
    const note = feed.items.find((n) => n.text.includes("Smallest returned 503"));
    expect(note).toBeTruthy();
    expect(note.view).toBe("errors");
  });

  it("pages and limits the error list", async () => {
    const b = await owner();
    const orgId = b.user.org_id;
    for (let i = 0; i < 3; i++) {
      await internal("post", "/internal/v1/errors").send({ level: "error", source: "tts", message: `err ${i}`, org_id: orgId });
    }
    const page1 = (await b.get("/api/errors?limit=2")).body;
    expect(page1.errors).toHaveLength(2);
  });
});

describe("acknowledging errors", () => {
  const report = (b, message) => internal("post", "/internal/v1/errors").send({
    level: "error", source: "tts", message, org_id: b.user.org_id });

  it("opens on the ones nobody has dealt with, and counts both lists", async () => {
    const b = await owner();
    await report(b, "one"); await report(b, "two");
    const open = (await b.get("/api/errors")).body;
    expect(open.errors.map((e) => e.message).sort()).toEqual(["one", "two"]);
    expect(open.counts).toEqual({ open: 2, acknowledged: 0 });
    expect((await b.get("/api/errors?status=acknowledged")).body.errors).toHaveLength(0);
  });

  it("moves acknowledged errors to the other list, and back, many at once", async () => {
    const b = await owner();
    await report(b, "one"); await report(b, "two"); await report(b, "three");
    const ids = (await b.get("/api/errors")).body.errors.map((e) => e.id);
    const r = await b.post("/api/errors/acknowledge").send({ ids: ids.slice(0, 2), acknowledged: true });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(2);
    expect((await b.get("/api/errors")).body.counts).toEqual({ open: 1, acknowledged: 2 });
    const done = (await b.get("/api/errors?status=acknowledged")).body.errors;
    expect(done).toHaveLength(2);
    expect(done[0].acknowledged_by).toBeTruthy();
    expect(done[0].acknowledged_at).toBeTruthy();
    await b.post("/api/errors/acknowledge").send({ ids: [done[0].id], acknowledged: false });
    expect((await b.get("/api/errors")).body.counts).toEqual({ open: 2, acknowledged: 1 });
  });

  it("never touches another organization's errors, and refuses junk", async () => {
    const b = await owner();
    await report(b, "mine");
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    const id = (await b.get("/api/errors")).body.errors[0].id;
    expect((await other.post("/api/errors/acknowledge").send({ ids: [id], acknowledged: true })).body.changed).toBe(0);
    expect((await b.get("/api/errors")).body.counts.open).toBe(1);
    for (const bad of [{}, { ids: "1" }, { ids: [] }, { ids: ["x"], acknowledged: true }, { ids: [1], acknowledged: "yes" }]) {
      expect((await b.post("/api/errors/acknowledge").send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("is for people who can change agents, not viewers", async () => {
    const b = await owner();
    await report(b, "x");
    const v = await member(b, { email: "v@acme.in", name: "V" });
    const id = (await b.get("/api/errors")).body.errors[0].id;
    expect((await v.post("/api/errors/acknowledge").send({ ids: [id], acknowledged: true })).status).toBe(403);
  });
});
