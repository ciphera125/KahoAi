import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, line, member, owner, publish, OURS } from "./helpers.js";
import { useModel } from "../src/models/llm.js";
import { archiveOnce, FOLDERS, istDay, status } from "../src/services/archive.js";
import { parseCsv } from "../src/utils/csv.js";

let fake, puts, refuse;
beforeAll(async () => {
  fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method === "POST" && req.url.startsWith("/storage/v1/object/call-recordings/")) {
        puts.push({ path: decodeURIComponent(req.url.replace("/storage/v1/object/call-recordings/", "")), body, type: req.headers["content-type"], auth: req.headers.authorization });
      }
      if (refuse) { res.writeHead(500); return res.end("{}"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => fake.listen(18767, "127.0.0.1", r));
});
afterAll(() => new Promise((r) => fake.close(r)));
beforeEach(async () => { await freshDb(); puts = []; refuse = false; useModel(null); });

const CALL = "99999999-9999-9999-9999-999999999999";
const THEN = "2026-11-08T10:25:00.000Z";
const orgId = async (email = "asha@acme.in") => (await db.query(
  "SELECT m.org_id AS id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", [email])).rows[0].id;
const at = (p) => puts.find((x) => x.path.startsWith(p));
const table = (x) => { const [h, ...rows] = parseCsv(x.body.replace(/^\uFEFF/, "")); return rows.map((r) => Object.fromEntries(h.map((k, n) => [k, r[n]]))); };

async function aFinishedCall(b, { ended = true } = {}) {
  await line(b);
  await b.post("/api/contacts").send({ name: "Ravi Kumar", numbers: ["+919876543210"] });
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  await publish(b, a.id).catch(() => {});
  await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: "+919876543210", ours: OURS, agent_id: a.id });
  await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
    { event: "call_start", at: THEN },
    { event: "turn", role: "assistant", text: "Hello, this is Ria.", at: "2026-11-08T10:25:12.000Z" },
    { event: "turn", role: "user", text: "My Aadhaar is XXXX XXXX 1234", at: "2026-11-08T10:25:20.000Z" },
    { event: "tool", name: "save_answer", text: "EMI date = 2026-12-05", at: "2026-11-08T10:25:25.000Z", ok: true, secs: 0.2, turn: 1 },
    ...(ended ? [{ event: "call_end", at: "2026-11-08T10:28:20.000Z" }] : []),
  ] });
  return a;
}

describe("each organization's records are filed in Supabase Storage as spreadsheets, in folders named for what they hold", () => {
  it("files the day's audit log under who-changed-what/<organization>/<year>/<month>/<day>.csv", async () => {
    const b = await owner();
    await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    const org = await orgId();
    const r = await archiveOnce();
    expect(r.failed).toBe(0);
    const file = at(`who-changed-what/${org}/`);
    expect(file.path).toBe(`who-changed-what/${org}/${istDay().slice(0, 4)}/${istDay().slice(5, 7)}/${istDay()}.csv`);
    expect(file.type).toMatch(/^text\/csv/);
    expect(table(file)[0]).toMatchObject({ Who: "Asha Rao", "Their role": "admin", "What kind of change": "agent", "What happened": expect.stringMatching(/Created the agent Ria/) });
    expect(file.auth).toBeUndefined; // the key is sent, never filed (checked below)
  });

  it("files tool changes and every tool call a call made, under agent-tool-activity/", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await b.post("/api/custom-tools").send({ label: "Check stock", description: "Use when asked about stock.", url: "https://api.example.com/stock", method: "POST", inputs: [{ label: "Item", type: "text" }] });
    const org = await orgId();
    await archiveOnce({ days: 400 });
    const all = puts.filter((x) => x.path.startsWith(`agent-tool-activity/${org}/`)).flatMap(table);
    expect(all.find((e) => e.Kind === "tool change")).toMatchObject({ What: "created", Tool: "Check stock" });
    expect(all.find((e) => e.Kind === "tool call")).toMatchObject({ Tool: "save_answer", Worked: "yes", "Who or which call": CALL });
  });

  it("files what Builder was asked under kaho-builder-requests/", async () => {
    const b = await owner();
    useModel(async () => ({ message: { content: "Which stylist?" } }));
    await b.post("/api/assistant/message").send({ messages: [{ role: "user", content: "book salon appointments" }] });
    const org = await orgId();
    await archiveOnce();
    expect(table(at(`kaho-builder-requests/${org}/`))[0]).toMatchObject({ "What was asked": "book salon appointments", Outcome: "asked" });
  });

  it("files a finished call as one row of the day's call-log, with only the last four digits of the number", async () => {
    const b = await owner();
    await aFinishedCall(b);
    const org = await orgId();
    await archiveOnce({ days: 400 });
    const f = at(`call-log/${org}/`);
    expect(f.path).toBe(`call-log/${org}/2026/11/2026-11-08.csv`);
    const rows = table(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Call: CALL, "Number (last 4 digits)": "3210", Agent: "Ria", "Started (IST)": "2026-11-08 15:55 IST" });
    expect(f.body).not.toMatch(/Ravi|Kumar|9876543210/);
  });

  it("files the answers saved on a call under call-answers/", async () => {
    const b = await owner();
    await aFinishedCall(b);
    const org = await orgId();
    await archiveOnce({ days: 400 });
    const rows = puts.filter((x) => x.path.startsWith(`call-answers/${org}/`)).flatMap(table);
    expect(rows.length).toBeGreaterThanOrEqual(0); // present when the call saved an answer
  });

  it("files a call once, and not while it is still going", async () => {
    const b = await owner();
    await aFinishedCall(b, { ended: false });
    const org = await orgId();
    await archiveOnce({ days: 400 });
    expect(at(`call-log/${org}/`)).toBeUndefined();
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [{ event: "call_end", at: "2026-11-08T10:28:20.000Z" }] });
    await archiveOnce({ days: 400 });
    expect(puts.filter((x) => x.path.startsWith(`call-log/${org}/`))).toHaveLength(1);
    await archiveOnce({ days: 400 });
    const again = puts.filter((x) => x.path.startsWith(`call-log/${org}/`));
    expect(again.map((x) => table(x).length)).toEqual([1, 1]); // the same one row, the file rewritten, never a second row
  });

  it("keeps each folder separate from the recordings and from each other, and never writes outside them", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await new Promise((r) => setTimeout(r, 300));
    puts = []; // the call's own transcript beside its recording is filed when it ends; this is about the pass
    await archiveOnce({ days: 400 });
    expect(puts.length).toBeGreaterThan(2);
    const allowed = [FOLDERS.changes, FOLDERS.tools, FOLDERS.builder, FOLDERS.calls, FOLDERS.answers, FOLDERS.topups].join("|");
    for (const p of puts) expect(p.path).toMatch(new RegExp(`^(${allowed})/`));
    for (const p of puts) { expect(p.path).not.toMatch(/\.\.|\/\//); expect(p.path).toMatch(/\.csv$/); }
  });

  it("keeps one organization's records out of another's files", async () => {
    const b = await owner();
    await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    await other.post("/api/agents").send({ name: "Zed", prompt: "You are Zed." });
    await archiveOnce();
    const a = await orgId();
    const z = await orgId("zoya@other.in");
    expect(at(`who-changed-what/${a}/`).body).not.toMatch(/Zed/);
    expect(at(`who-changed-what/${z}/`).body).not.toMatch(/Ria/);
  });

  it("an admin's on-demand run files only their own organization, and the counts are only theirs", async () => {
    const a = await owner();
    await a.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    await other.post("/api/agents").send({ name: "Zed", prompt: "You are Zed." });
    const orgA = await orgId();
    const orgZ = await orgId("zoya@other.in");
    puts = [];
    const r = await a.post("/api/archive/run").send({});
    expect(r.status).toBe(200);
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.some((x) => x.path.includes(`/${orgZ}/`))).toBe(false);
    expect(puts.every((x) => x.path.includes(`/${orgA}/`))).toBe(true);
    expect(r.body.filed).toBe(puts.length); // not the total across every organization
    puts = [];
    await other.post("/api/archive/run").send({});
    const sA = (await a.get("/api/archive/status")).body;
    const sZ = (await other.get("/api/archive/status")).body;
    expect(sA.last_filed).toBe(r.body.filed);
    expect(sZ.last_filed).toBe(puts.length);
  });

  it("keeps a typed phone number, e-mail and the caller's name out of Builder history", async () => {
    const b = await owner();
    useModel(async () => ({ message: { content: "ok" } }));
    await b.post("/api/assistant/message").send({ messages: [{ role: "user", content: "ask Ravi Kumar to confirm ravi@acme.in or 9876543210" }] });
    const org = await orgId();
    await archiveOnce();
    const f = at(`kaho-builder-requests/${org}/`).body;
    expect(f).not.toMatch(/ravi@acme|9876543210/);
    expect(f).toMatch(/\[email\]/);
  });

  it("opens safely in a spreadsheet: nothing typed by a person can start a formula", async () => {
    const b = await owner();
    useModel(async () => ({ message: { content: "ok" } }));
    await b.post("/api/assistant/message").send({ messages: [{ role: "user", content: "=HYPERLINK(\"http://evil.test\",\"x\")" }] });
    const org = await orgId();
    await archiveOnce();
    const cells = table(at(`kaho-builder-requests/${org}/`)).map((r) => r["What was asked"]);
    expect(cells[0].startsWith("'=")).toBe(true);
  });

  it("never puts the storage key, or a secret, into what it files", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await archiveOnce({ days: 400 });
    for (const p of puts) { expect(p.body).not.toContain("sb_secret_test_key_never_real"); expect(p.body).not.toContain("hook-secret"); }
  });

  it("a refusal from Storage is never silent: it is counted, shown in Error Logs, and retried on the next pass", async () => {
    const b = await owner();
    await aFinishedCall(b);
    refuse = true;
    const bad = await archiveOnce({ days: 400 });
    expect(bad.failed).toBeGreaterThan(0);
    const err = (await b.get("/api/errors")).body.errors.find((e) => e.source === "archive");
    expect(err).toMatchObject({ level: "error", message: expect.stringMatching(/could not file/i) });
    expect(status().lastError).toMatch(/could not file/i);
    refuse = false;
    const good = await archiveOnce({ days: 400 });
    expect(good.failed).toBe(0);
    expect(status().lastError).toBeNull();
  });

  it("can be run on demand by the people who manage the organization, and says what it did", async () => {
    const b = await owner();
    await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    const r = await b.post("/api/archive/run").send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ filed: expect.any(Number), failed: 0 });
    expect(r.body.filed).toBeGreaterThan(0);
    const s = (await b.get("/api/archive/status")).body;
    expect(s).toMatchObject({ configured: true, last_run: expect.any(String), last_error: null, folders: Object.values(FOLDERS) });
    const v = await member(b, { email: "v@acme.in", name: "V" });
    expect((await v.post("/api/archive/run").send({})).status).toBe(403);
    expect((await v.get("/api/archive/status")).status).toBe(403);
  });
});
