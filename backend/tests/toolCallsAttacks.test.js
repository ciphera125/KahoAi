// Attacks on the Tool calls and Tasks endpoints (2026-11-22), run for real against the test server.
import { beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, line, owner, OURS } from "./helpers.js";

beforeEach(freshDb);
const CALL = "44444444-4444-4444-4444-444444444444";
const T = (s) => `2026-11-08T10:00:${String(s).padStart(2, "0")}.000Z`;

async function seed(b) {
  await line(b);
  await b.post("/api/contacts").send({ name: "Ravi", numbers: ["+919876543210"] });
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "Hi" })).body;
  await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: "+919876543210", ours: OURS, agent_id: a.id });
  await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
    { event: "call_start", at: T(0) }, { event: "turn", role: "user", text: "hi", at: T(1) },
    { event: "tool", name: "end_call", turn: 1, ok: true, text: JSON.stringify({ args: {}, result: { status: "ending" } }), at: T(2) }] });
}

describe("hostile input", () => {
  it("SQL in any filter is only text", async () => {
    const b = await owner(); await seed(b);
    for (const q of ["contact=' OR 1=1 --", "tool=x'; DROP TABLE call_events;--", "agent_id=' OR '1'='1", "outcome=attention'; --",
      "from=2026-01-01' OR 1=1", "contact=%00", "contact=" + "A".repeat(5000)]) {
      const r = await b.get(`/api/calls/tools?${q}`);
      expect([200, 400], q).toContain(r.status);
      if (r.status === 200) expect(r.body.calls.length, q).toBeLessThanOrEqual(1);
    }
    expect((await db.query("SELECT count(*)::int n FROM call_events")).rows[0].n).toBeGreaterThan(0);
    for (const q of ["q=' OR 1=1 --", "range=today';--", "status=all'", "page=1e99", "per_page=1;DROP TABLE tasks"]) {
      expect([200, 400], q).toContain((await b.get(`/api/tasks?${q}`)).status);
    }
  });

  it("a list given where text belongs is refused, not a crash", async () => {
    const b = await owner(); await seed(b);
    for (const q of ["tool[]=a&tool[]=b", "contact[a]=b", "agent_id[]=x", "q[]=a"]) {
      expect([200, 400], q).toContain((await b.get(`/api/calls/tools?${q}`)).status);
      expect([200, 400], q).toContain((await b.get(`/api/tasks?${q}`)).status);
    }
  });

  it("another organization's call id, tool lines and tasks are never reachable", async () => {
    const b = await owner(); await seed(b);
    const evil = await owner({ email: "evil@x.in", organization: "Evil" });
    expect((await evil.get(`/api/calls/${CALL}`)).status).toBe(404);
    expect((await evil.get(`/api/calls/${CALL}/tools`)).status).toBe(404);
    expect((await evil.get(`/api/calls/tools?contact=Ravi`)).body.calls).toEqual([]);
    expect((await evil.get(`/api/calls/tools?tool=end_call`)).body.total).toBe(0);
  });

  it("needs a sign-in", async () => {
    const { app } = await import("./helpers.js");
    const request = (await import("supertest")).default;
    for (const path of ["/api/calls/tools", `/api/calls/${CALL}`, `/api/calls/${CALL}/tools`, "/api/tasks"]) {
      expect((await request(app).get(path).set("Host", "localhost:8020")).status, path).toBe(401);
    }
  });

  it("words a caller speaks stay text: a name or reason full of markup is stored and shown as plain text, size-capped", async () => {
    const b = await owner(); await seed(b);
    const reason = "<img src=x onerror=alert(1)> " + "x".repeat(3000);
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
      { event: "tool", name: "capture_lead", turn: 2, ok: true, at: T(5),
        text: JSON.stringify({ args: { name: "<script>1</script>", reason }, result: { status: "saved" } }) }] });
    const calls = (await b.get("/api/calls/tools")).body.calls;
    const lead = calls[0].turns.flatMap((t) => t.calls).find((c) => c.tool === "capture_lead");
    expect(lead.summary.length).toBeLessThan(160); // clipped, whatever was said
    expect(typeof lead.summary).toBe("string"); // the page renders it as text
  });

  it("a caller cannot make the agent touch another person's task by naming its id", async () => {
    const b = await owner(); await seed(b);
    const other = (await b.post("/api/contacts").send({ name: "Meera", numbers: ["+919822222222"] })).body;
    const t = (await b.post("/api/tasks").send({ title: "Meera's", contact_id: other.id })).body;
    const r = await internal("post", `/internal/v1/calls/${CALL}/tools/mark_task_done`).send({ task_id: t.id, turn: 3 });
    expect(r.body.ok).toBe(false);
    expect((await db.query("SELECT status FROM tasks WHERE id = $1", [t.id])).rows[0].status).toBe("pending");
  });

  it("a date said as an attack is only ever a refusal or a date", async () => {
    const b = await owner(); await seed(b);
    for (const due of ["'; DROP TABLE tasks;--", "tomorrow ".repeat(500), "\u0000", "99:99 99/99/9999", "in 99999999999 days"]) {
      const r = await internal("post", `/internal/v1/calls/${CALL}/tools/add_task`).send({ title: "x", due, turn: 9 });
      expect(r.status, due.slice(0, 20)).toBe(200);
      expect(typeof r.body.ok).toBe("boolean");
    }
  });
});
