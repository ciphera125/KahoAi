// What is filed in Supabase Storage (owner, 2026-11-15): only spreadsheets (CSV) that open anywhere, in folders and files
// named for what they hold, with the admin's own records in a separate bucket that is not the customers'.
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { db, freshDb, internal, line, owner, publish, OURS } from "./helpers.js";
import { useModel } from "../src/models/llm.js";
import { archiveOnce, istDay, FOLDERS, ADMIN_FOLDERS } from "../src/services/archive.js";
import { archiveAdmin } from "../src/services/archiveAdmin.js";
import { publishCallFiles } from "../src/services/callFiles.js";
import { parseCsv } from "../src/utils/csv.js";
import * as Billing from "../src/models/Billing.js";
import * as Requests from "../src/models/Requests.js";

const MAIN = "kaho-customer-records", ADMIN = "kaho-admin-records";
let fake, puts;
beforeAll(async () => {
  fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const m = req.url.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
      if (req.method === "POST" && m && m[1] !== "move") puts.push({ bucket: m[1], path: decodeURIComponent(m[2]), body: Buffer.concat(chunks).toString("utf8"), type: req.headers["content-type"] });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
    });
  });
  await new Promise((r) => fake.listen(18767, "127.0.0.1", r));
});
afterAll(() => new Promise((r) => fake.close(r)));
beforeEach(async () => {
  await freshDb(); puts = []; useModel(null);
  config.SUPABASE_RECORDINGS_BUCKET = MAIN; config.SUPABASE_ADMIN_BUCKET = ADMIN;
});

const CALL = "99999999-9999-9999-9999-999999999999";
const rowsOf = (p) => parseCsv(p.body.replace(/^﻿/, ""));
const find = (bucket, prefix) => puts.filter((x) => x.bucket === bucket && x.path.startsWith(prefix));
async function aCall(b) {
  await line(b);
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  await publish(b, a.id).catch(() => {});
  await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: "+919876543210", ours: OURS, agent_id: a.id });
  await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
    { event: "call_start", at: new Date(Date.now() - 180000).toISOString() },
    { event: "turn", role: "assistant", text: "Hello, this is Ria.", at: new Date(Date.now() - 170000).toISOString() },
    { event: "turn", role: "user", text: "Reach me on ravi@example.com", at: new Date(Date.now() - 160000).toISOString() },
    { event: "call_end", at: new Date().toISOString() },
  ] });
}

describe("only spreadsheets, in folders named for what is in them", () => {
  it("has plain-English folder names and no numbers", () => {
    expect(FOLDERS).toEqual({ recordings: "call-recordings", transcripts: "call-transcripts", changes: "who-changed-what", tools: "agent-tool-activity",
      builder: "kaho-builder-requests", calls: "call-log", answers: "call-answers", topups: "topups-and-minutes" });
    expect(Object.values(ADMIN_FOLDERS).sort()).toEqual(["admin-activity", "all-topups", "customer-requests", "organizations", "people"]);
  });

  it("files every record as a .csv with a header row in words, never JSON", async () => {
    const b = await owner();
    await aCall(b);
    await Billing.assign((await db.query("SELECT org_id FROM users LIMIT 1")).rows[0].org_id, { planId: "start", adminEmail: "t" });
    const r = await archiveOnce();
    expect(r.failed).toBe(0);
    const mine = puts.filter((x) => x.bucket === MAIN);
    expect(mine.length).toBeGreaterThan(3);
    for (const p of mine) {
      expect(p.path, p.path).toMatch(/\.csv$/);
      expect(p.path).not.toMatch(/\.jsonl?$/);
      expect(p.type).toMatch(/^text\/csv/);
      expect(p.body.startsWith("﻿"), "opens with accents and Hindi intact in a spreadsheet").toBe(true);
      expect(rowsOf(p)[0].every((h) => /^[A-Z][A-Za-z0-9 ()/'-]+$/.test(h)), JSON.stringify(rowsOf(p)[0])).toBe(true);
    }
  });

  it("files the day's calls and the answers saved, one row per call, with the number cut to its last four digits", async () => {
    const b = await owner(); await aCall(b);
    await archiveOnce();
    const log = find(MAIN, "call-log/")[0];
    expect(log.path).toMatch(new RegExp(`^call-log/org_[0-9a-f]+/${istDay().slice(0, 4)}/${istDay().slice(5, 7)}/${istDay()}\\.csv$`));
    const [head, ...rows] = rowsOf(log);
    expect(head).toEqual(expect.arrayContaining(["Call", "Started (IST)", "Agent", "Direction", "Outcome", "Length (seconds)", "Number (last 4 digits)"]));
    expect(rows).toHaveLength(1);
    expect(rows[0][head.indexOf("Number (last 4 digits)")]).toBe("3210");
    expect(log.body).not.toContain("9876543210");
  });

  it("keeps a call's words as a transcript spreadsheet: time, who spoke, what was said, with contact details removed", async () => {
    const b = await owner(); await aCall(b);
    await publishCallFiles(CALL);
    const t = puts.find((x) => x.bucket === MAIN && x.path.startsWith("call-transcripts/"));
    expect(t.path).toMatch(/^call-transcripts\/\d{4}-\d{2}-\d{2}_\d{4}_99999999\.csv$/);
    const [head, ...rows] = rowsOf(t);
    expect(head).toEqual(["Time (IST)", "Who spoke", "What was said"]);
    expect(rows.map((r) => r[1])).toEqual(["Agent", "Caller"]);
    expect(t.body).not.toContain("ravi@example.com");
  });
});

describe("the admin's records have a bucket of their own", () => {
  it("is a different bucket, and nothing from it goes into the customers'", async () => {
    const b = await owner(); await aCall(b);
    await new Promise((r) => setTimeout(r, 300)); puts = []; // the call's own file is filed in the background
    await archiveAdmin();
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.map((p) => `${p.bucket}:${p.path}`).filter((x) => !x.startsWith(`${ADMIN}:`))).toEqual([]);
    await archiveOnce();
    expect(puts.filter((p) => p.bucket === MAIN).every((p) => !/^(admin|people|organizations|customer-requests|all-topups)/.test(p.path))).toBe(true);
  });

  it("files the admin activity, every organization and plan, the rate card, requests, top-ups and the people, each as a csv", async () => {
    const b = await owner();
    const org = (await db.query("SELECT org_id FROM users LIMIT 1")).rows[0].org_id;
    await Billing.assign(org, { planId: "growth", adminEmail: "t" });
    await Billing.createTopup(org, { userId: b.user.id, minutes: 100 });
    await Requests.create(org, { kind: "message", message: "call me on 9876543210", userName: "Asha" });
    await db.query("INSERT INTO admin_audit (admin_email, action, org_id, detail) VALUES ('staff@kaho.test', 'org.rename', $1, 'Renamed to Acme')", [org]);
    const r = await archiveAdmin();
    expect(r.failed).toBe(0);
    const names = puts.map((p) => p.path);
    expect(names).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^admin-activity/${istDay().slice(0, 4)}/${istDay().slice(5, 7)}/${istDay()}\\.csv$`)),
      "organizations/organizations-and-plans.csv", "organizations/plans-and-rates.csv", "people/admin-accounts.csv",
      "people/all-users.csv", "people/all-emails.csv", "people/unique-users.csv",
      expect.stringMatching(/^customer-requests\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.csv$/), expect.stringMatching(/^all-topups\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.csv$/)]));
    for (const p of puts) { expect(p.path).toMatch(/\.csv$/); expect(p.type).toMatch(/^text\/csv/); }
    const orgs = rowsOf(puts.find((p) => p.path === "organizations/organizations-and-plans.csv"));
    expect(orgs[0]).toEqual(expect.arrayContaining(["Organization", "Name", "Plan", "Status", "Minutes left", "People"]));
    expect(orgs[1][orgs[0].indexOf("Plan")]).toBe("Growth");
    const asks = puts.find((p) => p.path.startsWith("customer-requests/"));
    expect(asks.body).not.toContain("9876543210"); // free text is masked like all other call content
  });

  it("never holds a password, a hash, a session or the setup code", async () => {
    await owner();
    const { signedInAdmin } = await import("./adminHelpers.js");
    config.ADMIN_SIGNUP_CODE = "test-admin-setup-code-0123456789";
    await signedInAdmin();
    await archiveAdmin();
    const all = puts.map((p) => p.body).join("\n");
    expect(all).not.toMatch(/scrypt|salt|token_hash|test-admin-setup-code|a long admin passphrase|another pass/i);
    const accounts = rowsOf(puts.find((p) => p.path === "people/admin-accounts.csv"));
    expect(accounts[0]).toEqual(["Name", "E-mail", "Created", "Last signed in"]);
    expect(accounts).toHaveLength(2);
  });

  it("does nothing, and says so, when no admin bucket is set", async () => {
    config.SUPABASE_ADMIN_BUCKET = "";
    expect(await archiveAdmin()).toMatchObject({ skipped: true, filed: 0 });
    expect(puts).toHaveLength(0);
  });

  it("counts a refusal from Storage instead of hiding it", async () => {
    await owner();
    config.SUPABASE_URL = "http://127.0.0.1:1"; // nothing listens
    const r = await archiveAdmin();
    expect(r.failed).toBeGreaterThan(0);
    config.SUPABASE_URL = "http://127.0.0.1:18767";
  });
});
