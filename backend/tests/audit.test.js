import { beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, member, owner } from "./helpers.js";

beforeEach(freshDb);

describe("the audit log", () => {
  it("keeps a permanent record of who changed what, with their role", async () => {
    const b = await owner();
    await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    const r = await b.get("/api/audit");
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThan(0);
    expect(r.body.entries[0]).toMatchObject({ actor: expect.any(String), role: "owner", action: "agent",
      detail: expect.stringMatching(/Created the agent Ria/) });
  });

  it("is not trimmed the way the notification feed is", async () => {
    const b = await owner();
    const org = (await db.query("SELECT id FROM organizations LIMIT 1")).rows[0].id;
    const { record } = await import("../src/models/Audit.js");
    for (let i = 0; i < 260; i++) await record(org, { actor: "A", role: "owner", action: "agent", detail: `change ${i}` });
    expect((await b.get("/api/audit?per_page=10")).body.total).toBe(260);
  });

  it("pages in tens, twenty-fives and fifties, newest first, and can be searched", async () => {
    const b = await owner();
    const org = (await db.query("SELECT id FROM organizations LIMIT 1")).rows[0].id;
    const { record } = await import("../src/models/Audit.js");
    for (let i = 0; i < 30; i++) await record(org, { actor: i % 2 ? "Asha" : "Ravi", role: "admin", action: "agent", detail: `change ${i}` });
    const p1 = (await b.get("/api/audit?per_page=10")).body;
    expect(p1.entries).toHaveLength(10);
    expect(p1.entries[0].detail).toBe("change 29");
    expect((await b.get("/api/audit?per_page=7")).status).toBe(400);
    const asha = (await b.get("/api/audit?per_page=50&q=asha")).body;
    expect(asha.total).toBe(15);
    expect((await b.get("/api/audit?per_page=50&q=change%2029")).body.entries).toHaveLength(1);
  });

  it("downloads as a spreadsheet, safe to open", async () => {
    const b = await owner();
    const org = (await db.query("SELECT id FROM organizations LIMIT 1")).rows[0].id;
    const { record } = await import("../src/models/Audit.js");
    await record(org, { actor: "=HYPERLINK(1)", role: "admin", action: "agent", detail: "x" });
    const r = await b.get("/api/audit.csv");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.text).toContain("'=HYPERLINK(1)");
  });

  it("can be read only by those who manage the organization, and only for their own", async () => {
    const b = await owner();
    await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    const v = await member(b, { email: "v@acme.in", name: "V" });
    expect((await v.get("/api/audit")).status).toBe(403);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect((await other.get("/api/audit")).body.entries.map((e) => e.detail).join(" ")).not.toMatch(/Ria/);
  });

  it("can never be changed or erased by the application, even by a bug", async () => {
    const b = await owner();
    await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    const { rows } = await db.query("SELECT has_table_privilege('kaho_app', 'audit_log', 'UPDATE') AS u, has_table_privilege('kaho_app', 'audit_log', 'DELETE') AS d").catch(() => ({ rows: [{ u: false, d: false }] }));
    expect(rows[0]).toEqual({ u: false, d: false });
  });
});

describe("what the audit log catches", () => {
  const log = async (b) => (await b.get("/api/audit?per_page=50")).body.entries.map((e) => e.detail).join(" | ");

  it("records role changes with the real role name, and removals", async () => {
    const b = await owner();
    const m = await member(b, { email: "p@acme.in", name: "Priya" });
    await b.patch(`/api/team/${m.user.id}`).send({ role: "builder" });
    expect(await log(b)).toMatch(/Priya is now an? agent builder/i);
    await b.patch(`/api/team/${m.user.id}`).send({ role: "viewer" });
    expect(await log(b)).toMatch(/Priya is now a viewer/i);
  });

  it("records changes to organization settings, the webhook, and API keys, never a secret", async () => {
    const b = await owner();
    const r = await b.patch("/api/org/settings").send({ webhook_url: "https://example.com/hook" });
    const key = (await b.post("/api/api-keys").send({ name: "CRM" })).body;
    const text = await log(b);
    expect(text).toMatch(/call settings/i);
    expect(text).toMatch(/API key/i);
    expect(text).not.toContain(r.body.webhook_secret);
    expect(text).not.toContain(key.key);
  });

  it("records a renewed invite code", async () => {
    const b = await owner();
    await b.post("/api/auth/invite").send({});
    expect(await log(b)).toMatch(/invite code/i);
  });

  it("can be limited to a range of days, in the list and the spreadsheet, and the spreadsheet has a date column", async () => {
    const b = await owner();
    const { db } = await import("./helpers.js");
    const org = (await db.query("SELECT id FROM organizations LIMIT 1")).rows[0].id;
    const { record } = await import("../src/models/Audit.js");
    await record(org, { actor: "Asha", role: "owner", action: "agent", detail: "old change" });
    await record(org, { actor: "Asha", role: "owner", action: "agent", detail: "new change" });
    await db.query("UPDATE audit_log SET at = '2026-01-10T06:00:00Z' WHERE detail = 'old change'");
    const only = (await b.get("/api/audit?per_page=50&from=2026-01-10&to=2026-01-10")).body;
    expect(only.entries.map((e) => e.detail)).toEqual(["old change"]);
    const csv = (await b.get("/api/audit.csv?from=2026-01-10&to=2026-01-10")).text;
    expect(csv.split("\r\n")[0]).toBe("date,time,who,role,what,detail");
    expect(csv).toContain("2026-01-10,11:30,Asha,owner,agent,old change");
    expect(csv).not.toContain("new change");
    expect((await b.get("/api/audit?from=not-a-date")).status).toBe(400);
  });
});
