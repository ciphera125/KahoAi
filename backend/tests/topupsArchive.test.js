// The top-up section's own folder in Supabase Storage: every request, decision and credit, one file a day,
// rewritten whole from the database. It holds no name, e-mail or number, and no per-call usage.
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config/env.js";
import { db, freshDb, owner } from "./helpers.js";
import * as Billing from "../src/models/Billing.js";
import { archiveOnce, FOLDERS, istDay } from "../src/services/archive.js";
import { parseCsv } from "../src/utils/csv.js";

let fake, puts, refuse;
beforeAll(async () => {
  config.BILLING_ENFORCED = true;
  fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url.startsWith("/storage/v1/object/call-recordings/")) {
        puts.push({ path: decodeURIComponent(req.url.replace("/storage/v1/object/call-recordings/", "")), body: Buffer.concat(chunks).toString("utf8") });
      }
      if (refuse) { res.writeHead(500); return res.end("{}"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => fake.listen(18767, "127.0.0.1", r));
});
afterAll(async () => { config.BILLING_ENFORCED = false; await new Promise((r) => fake.close(r)); });
beforeEach(async () => { await freshDb(); puts = []; refuse = false; });

const lines = (file) => { const [h, ...rows] = parseCsv(file.body.replace(/^\uFEFF/, "")); return rows.map((r) => Object.fromEntries(h.map((k, n) => [k, r[n]]))); };
const day = (d) => `${d.slice(0, 4)}/${d.slice(5, 7)}/${d}`;
async function aTopupPaid() {
  const b = await owner();
  const org = b.user.org_id;
  await Billing.assign(org, { planId: "start", adminEmail: "aayushimakker10@gmail.com" });
  const t = await Billing.createTopup(org, { userId: b.user.id, userName: b.user.name, minutes: 250 });
  await Billing.decideTopup(t.id, { approve: true, adminEmail: "aayushimakker10@gmail.com", note: "UPI ref 998877" });
  return { b, org, t };
}

describe("the top-up folder", () => {
  it("has a plain name, and the Studio's status page lists it", () => {
    expect(Object.values(FOLDERS)).toContain("topups-and-minutes");
  });

  it("files the request, the confirmation and the credit under its own folder, by day", async () => {
    const { org, t } = await aTopupPaid();
    const r = await archiveOnce();
    expect(r.failed).toBe(0);
    const file = puts.find((p) => p.path.startsWith(`topups-and-minutes/${org}/`));
    expect(file.path).toBe(`topups-and-minutes/${org}/${day(istDay())}.csv`);
    const rows = lines(file);
    expect(rows.filter((x) => x.Reference).map((x) => x["What happened"])).toEqual(["requested", "paid and minutes added"]);
    expect(rows.find((x) => x["What happened"] === "requested")).toMatchObject({ Minutes: "250", "Price per minute (paise)": "550", "Amount (paise)": "137500", Reference: t.reference });
    expect(rows.filter((x) => !x.Reference).map((x) => [x["What happened"], x.Minutes])).toEqual([["minutes from the plan", "1100"], ["minutes added by a top-up", "250"]]);
  });

  it("holds no name, e-mail, number or reference to a person, and no per-call usage", async () => {
    const { b, org } = await aTopupPaid();
    await db.query(`INSERT INTO calls (call_id, org_id, duration_secs, started_at) VALUES ('call-zzzz-0001', $1, 130, now())`, [org]);
    await Billing.settleUsage("call-zzzz-0001");
    await Billing.adjust(org, 10, { actor: "Kaho AI", note: "Call Ravi Kumar on 9876543210 about it" });
    await archiveOnce();
    const body = puts.filter((p) => p.path.startsWith("topups-and-minutes/")).map((p) => p.body).join("\n");
    expect(body).not.toMatch(/@/);
    expect(body).not.toContain(b.user.name);
    expect(body).not.toMatch(/9876543210/);
    expect(body).not.toMatch(/call-zzzz-0001|usage/);
    expect(lines({ body })).toEqual(expect.arrayContaining([expect.objectContaining({ By: b.user.id })]));
  });

  it("puts a request in the day it was made and its confirmation in the day it was decided", async () => {
    const { org, t } = await aTopupPaid();
    await db.query("UPDATE topups SET created_at = now() - interval '1 day' WHERE id = $1", [t.id]);
    await archiveOnce({ days: 3 });
    const files = puts.filter((p) => p.path.startsWith(`topups-and-minutes/${org}/`));
    expect(files).toHaveLength(2);
    const events = Object.fromEntries(files.map((f) => [f.path.split("/").pop().replace(".csv", ""), lines(f).filter((x) => x.Reference).map((x) => x["What happened"])]));
    expect(Object.values(events).sort()).toEqual([["paid and minutes added"], ["requested"]]);
  });

  it("a withdrawn request shows as withdrawn, by the requester, not by staff", async () => {
    const b = await owner();
    await Billing.assign(b.user.org_id, { planId: "start", adminEmail: "a@kaho.in" });
    const t = await Billing.createTopup(b.user.org_id, { userId: b.user.id, minutes: 100 });
    await Billing.cancelTopup(b.user.org_id, t.id);
    await archiveOnce();
    const rows = puts.flatMap(lines).filter((x) => x.Reference);
    expect(rows.map((x) => x["What happened"])).toEqual(["requested", "withdrawn"]);
    expect(rows.at(-1).By).toBe(b.user.id);
  });

  it("a refusal from Storage is counted and tried again, and the database stays the record", async () => {
    await aTopupPaid();
    refuse = true;
    const first = await archiveOnce();
    expect(first.failed).toBeGreaterThan(0);
    refuse = false;
    puts = [];
    const second = await archiveOnce();
    expect(second.failed).toBe(0);
    expect(puts.some((p) => p.path.startsWith("topups-and-minutes/"))).toBe(true);
  });

  it("files nothing for an organization with no top-ups or credits", async () => {
    await owner();
    await archiveOnce();
    expect(puts.some((p) => p.path.startsWith("topups-and-minutes/"))).toBe(false);
  });
});
