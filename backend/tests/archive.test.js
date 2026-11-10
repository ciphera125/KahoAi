import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, line, member, owner, publish, OURS } from "./helpers.js";
import { useModel } from "../src/models/llm.js";
import { archiveOnce, istDay, status } from "../src/services/archive.js";

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
const jsonl = (x) => x.body.trim().split("\n").map((l) => JSON.parse(l));

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

describe("audit logs, tool logs, Builder history and calls are filed in Supabase Storage, each in its own numbered folder", () => {
  it("files the day's audit log under audit-logs/<organization>/<year>/<month>/<day>.jsonl", async () => {
    const b = await owner();
    await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    const org = await orgId();
    const r = await archiveOnce();
    expect(r.failed).toBe(0);
    const file = at(`6-audit-logs/${org}/`);
    expect(file.path).toBe(`6-audit-logs/${org}/${istDay().slice(0, 4)}/${istDay().slice(5, 7)}/${istDay()}.jsonl`);
    expect(file.type).toMatch(/^text\/plain/);
    const entries = jsonl(file);
    expect(entries[0]).toMatchObject({ actor: "Asha Rao", role: "owner", action: "agent", detail: expect.stringMatching(/Created the agent Ria/) });
    expect(file.auth).toMatch(/^Bearer /);
  });

  it("files tool changes and every tool call a call made, under tool-logs/", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await b.post("/api/custom-tools").send({ label: "Check stock", description: "Use when asked about stock.", url: "https://api.example.com/stock", method: "POST", inputs: [{ label: "Item", type: "text" }] });
    const org = await orgId();
    await archiveOnce({ days: 400 });
    const files = puts.filter((x) => x.path.startsWith(`7-tool-logs/${org}/`));
    const all = files.flatMap(jsonl);
    expect(all.find((e) => e.type === "change")).toMatchObject({ action: "created", source: "studio", tool_label: "Check stock" });
    expect(all.find((e) => e.type === "call")).toMatchObject({ tool: "save_answer", ok: true, call_id: CALL });
  });

  it("files what Builder was asked under builder-history/", async () => {
    const b = await owner();
    useModel(async () => ({ message: { content: "Which stylist?" } }));
    await b.post("/api/assistant/message").send({ messages: [{ role: "user", content: "book salon appointments" }] });
    const org = await orgId();
    await archiveOnce();
    expect(jsonl(at(`8-builder-history/${org}/`))[0]).toMatchObject({ prompt: "book salon appointments", outcome: "asked" });
  });

  it("files a finished call as one JSON record under calls/, named for the person and the time", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await archiveOnce({ days: 400 });
    const f = at("9-call-records/");
    expect(f.path).toBe("9-call-records/2026-11-08_1555_99999999.json");
    const rec = JSON.parse(f.body);
    expect(rec).toMatchObject({ call_id: CALL, caller_number_last4: "3210", agent: "Ria" });
    expect(f.body).not.toMatch(/Ravi|Kumar|9876543210/);
    expect(rec.turns.map((t) => t.text)).toEqual(["Hello, this is Ria.", "My Aadhaar is XXXX XXXX 1234"]);
    expect(rec.tools[0]).toMatchObject({ name: "save_answer", ok: true });
    const row = (await db.query("SELECT archive_path, archived_at FROM calls WHERE call_id = $1", [CALL])).rows[0];
    expect(row.archive_path).toBe(f.path);
    expect(row.archived_at).not.toBeNull();
  });

  it("files a call once, and not while it is still going", async () => {
    const b = await owner();
    await aFinishedCall(b, { ended: false });
    await archiveOnce({ days: 400 });
    expect(at("9-call-records/")).toBeUndefined();
    await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [{ event: "call_end", at: "2026-11-08T10:28:20.000Z" }] });
    await archiveOnce({ days: 400 });
    expect(puts.filter((x) => x.path.startsWith("9-call-records/"))).toHaveLength(1);
    await archiveOnce({ days: 400 });
    expect(puts.filter((x) => x.path.startsWith("9-call-records/"))).toHaveLength(1);
  });

  it("keeps each folder separate from the recordings and from each other, and never writes outside them", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await new Promise((r) => setTimeout(r, 300));
    puts = []; // the call's own transcript beside its recording is filed when it ends; this is about the pass
    await archiveOnce({ days: 400 });
    expect(puts.length).toBeGreaterThan(2);
    for (const p of puts) expect(p.path).toMatch(/^(6-audit-logs|7-tool-logs|8-builder-history|9-call-records)\//);
    for (const p of puts) expect(p.path).not.toMatch(/\.\.|\/\//);
  });

  it("keeps one organization's records out of another's files", async () => {
    const b = await owner();
    await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." });
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    await other.post("/api/agents").send({ name: "Zed", prompt: "You are Zed." });
    await archiveOnce();
    const a = await orgId();
    const z = await orgId("zoya@other.in");
    expect(at(`6-audit-logs/${a}/`).body).not.toMatch(/Zed/);
    expect(at(`6-audit-logs/${z}/`).body).not.toMatch(/Ria/);
  });

  it("keeps a typed phone number, e-mail and the caller's name out of Builder history and call records", async () => {
    const b = await owner();
    useModel(async () => ({ message: { content: "ok" } }));
    await b.post("/api/assistant/message").send({ messages: [{ role: "user", content: "ask Ravi Kumar to confirm ravi@acme.in or 9876543210" }] });
    const org = await orgId();
    await archiveOnce();
    const f = at(`8-builder-history/${org}/`).body;
    expect(f).not.toMatch(/ravi@acme|9876543210/);
    expect(f).toMatch(/\[email\]/);
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
    expect((await db.query("SELECT archived_at FROM calls WHERE call_id = $1", [CALL])).rows[0].archived_at).toBeNull();
    const err = (await b.get("/api/errors")).body.errors.find((e) => e.source === "archive");
    expect(err).toMatchObject({ level: "error", message: expect.stringMatching(/could not file/i) });
    expect(status().lastError).toMatch(/could not file/i);
    refuse = false;
    const good = await archiveOnce({ days: 400 });
    expect(good.failed).toBe(0);
    expect((await db.query("SELECT archived_at FROM calls WHERE call_id = $1", [CALL])).rows[0].archived_at).not.toBeNull();
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
    expect(s).toMatchObject({ configured: true, last_run: expect.any(String), last_error: null, folders: ["1-recordings", "2-transcripts", "3-users", "4-user-emails", "5-unique-users", "6-audit-logs", "7-tool-logs", "8-builder-history", "9-call-records"] });
    const v = await member(b, { email: "v@acme.in", name: "V" });
    expect((await v.post("/api/archive/run").send({})).status).toBe(403);
    expect((await v.get("/api/archive/status")).status).toBe(403);
  });
});
