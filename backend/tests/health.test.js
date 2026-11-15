import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, member, owner } from "./helpers.js";
import { config } from "../src/config/env.js";
import { startFakes } from "./fakes.js";

let fakes, groq, storage, groqStatus, storageStatus, groqBody;
beforeAll(async () => {
  fakes = await startFakes();
  const mk = (port, handle) => new Promise((resolve) => { const s = http.createServer(handle); s.listen(port, "127.0.0.1", () => resolve(s)); });
  groq = await mk(18768, (req, res) => { res.writeHead(groqStatus, { "Content-Type": "application/json" }); res.end(groqBody ?? "{}"); });
  storage = await mk(18767, (req, res) => { req.resume(); req.on("end", () => { res.writeHead(storageStatus); res.end("{}"); }); });
});
afterAll(async () => { await fakes.close(); await Promise.all([groq, storage].map((s) => new Promise((r) => s.close(r)))); });
const saved = { ...config };
beforeEach(async () => {
  await freshDb();
  groqStatus = 200; storageStatus = 200; groqBody = undefined;
  fakes.plivo.reply = { status: 200, body: {} };
  fakes.voice.reply = { status: 200, body: "<Response/>" };
  config.GROQ_API_KEY = "gsk_test_key_never_real";
  config.GROQ_API_BASE = "http://127.0.0.1:18768";
  config.HEALTH_TIMEOUT_MS = 800;
});
afterEach(() => Object.assign(config, saved));

const by = (r, id) => r.body.checks.find((c) => c.id === id);
async function withPlivo(b) {
  await b.post("/api/numbers").send({ provider: "plivo", number: "+918065520552", label: "Main", credentials: { auth_id: "MAXXXXXXXXXXXXXXXXXX", auth_token: "plivo_token_never_real" } });
}

describe("the system check says what is really working", () => {
  it("checks the database, the model, Storage, Plivo and the phone server, each for real", async () => {
    const b = await owner();
    await withPlivo(b);
    const r = await b.get("/api/system/health");
    expect(r.status).toBe(200);
    expect(r.body.checks.map((c) => c.id)).toEqual(["database", "connections", "model", "storage", "plivo", "phone_server"]);
    expect(r.body.checks.every((c) => c.ok)).toBe(true);
    expect(r.body.ok).toBe(true);
    expect(fakes.plivo.requests.some((x) => x.method === "GET" && x.url.startsWith("/v1/Account/MAXXXXXXXXXXXXXXXXXX/"))).toBe(true);
    expect(fakes.voice.requests.length).toBeGreaterThan(0);
  });

  it("says how many database connections are in use and whether they fit what the database allows", async () => {
    const b = await owner();
    const r = await b.get("/api/system/health");
    const c = r.body.checks.find((x) => x.id === "connections");
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/of \d+ .*in use|connections/i);
    expect(c.detail).toMatch(/PGPOOL_MAX|database connections/i);
    expect(c.detail).not.toMatch(/postgres:\/\/|password/i);
  });

  it("says the model's key was refused, plainly, without stopping the other checks", async () => {
    const b = await owner();
    await withPlivo(b);
    groqStatus = 401;
    const r = await b.get("/api/system/health");
    expect(r.status).toBe(200);
    expect(by(r, "model")).toMatchObject({ ok: false, detail: expect.stringMatching(/refused.*401/i) });
    expect(by(r, "database").ok).toBe(true);
    expect(r.body.ok).toBe(false);
  });

  it("says Storage cannot be written to when it refuses", async () => {
    const b = await owner();
    storageStatus = 403;
    expect(by(await b.get("/api/system/health"), "storage")).toMatchObject({ ok: false, detail: expect.stringMatching(/storage/i) });
  });

  it("says when something is not set up at all, instead of leaving it out", async () => {
    const b = await owner();
    config.GROQ_API_KEY = undefined;
    config.SUPABASE_SECRET_KEY = undefined;
    const r = await b.get("/api/system/health");
    expect(by(r, "model")).toMatchObject({ ok: false, detail: expect.stringMatching(/not set up/i) });
    expect(by(r, "storage")).toMatchObject({ ok: false, detail: expect.stringMatching(/not set up/i) });
    expect(by(r, "plivo")).toMatchObject({ ok: false, detail: expect.stringMatching(/no plivo number/i) });
  });

  it("gives up on a service that never answers, inside the deadline", async () => {
    const b = await owner();
    await withPlivo(b);
    fakes.plivo.reply = { hang: true };
    const t = Date.now();
    const r = await b.get("/api/system/health");
    expect(Date.now() - t).toBeLessThan(4000);
    expect(by(r, "plivo")).toMatchObject({ ok: false, detail: expect.stringMatching(/did not answer|could not reach/i) });
  });

  it("warns about settings that are fine for trying things out but not for real customers", async () => {
    const b = await owner();
    config.NODE_ENV = "development";
    config.REQUIRE_AGENT_TEST = false;
    const r = await b.get("/api/system/health");
    expect(r.body.warnings.join(" ")).toMatch(/NODE_ENV/);
    expect(r.body.warnings.join(" ")).toMatch(/publish.*without.*test/i);
  });

  it("never shows a key, a token or a secret", async () => {
    const b = await owner();
    await withPlivo(b);
    groqStatus = 500;
    const text = JSON.stringify((await b.get("/api/system/health")).body);
    for (const secret of ["gsk_test_key_never_real", "plivo_token_never_real", "sb_secret_test_key_never_real", "hook-secret"]) expect(text).not.toContain(secret);
  });

  it("is for the people who manage the organization", async () => {
    const b = await owner();
    const v = await member(b, { email: "v@acme.in", name: "V" });
    expect((await v.get("/api/system/health")).status).toBe(403);
    expect((await db.query("SELECT 1")).rowCount).toBe(1);
  });
});

describe("settings that quietly switch the money off", () => {
  it("says plainly when billing is not being enforced, because then nothing is charged, locked or counted", async () => {
    const { warnings } = await import("../src/services/health.js");
    const base = { NODE_ENV: "production", REQUIRE_AGENT_TEST: true, TRANSFER_NUMBER: "+911234567890", DATABASE_SSL: "verify", WEB_CONCURRENCY: 1 };
    expect(warnings({ ...base, BILLING_ENFORCED: true })).toEqual([]);
    const w = warnings({ ...base, BILLING_ENFORCED: false });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/BILLING_ENFORCED/);
    expect(w[0]).toMatch(/no plan|locked|charged|counted/i);
  });

  it("says when plans start themselves, without anyone confirming payment", async () => {
    const { warnings } = await import("../src/services/health.js");
    const base = { NODE_ENV: "production", REQUIRE_AGENT_TEST: true, TRANSFER_NUMBER: "+911234567890", DATABASE_SSL: "verify", WEB_CONCURRENCY: 1, BILLING_ENFORCED: true };
    const w = warnings({ ...base, SUBSCRIPTION_AUTO_ACTIVATE: true });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/SUBSCRIPTION_AUTO_ACTIVATE/);
  });
});

describe("settings that quietly weaken the limits", () => {
  it("several workers without Redis are warned about: every worker would keep its own count", async () => {
    const { warnings } = await import("../src/services/health.js");
    const base = { NODE_ENV: "production", REQUIRE_AGENT_TEST: true, TRANSFER_NUMBER: "+911234567890", DATABASE_SSL: "verify" };
    expect(warnings({ ...base, WEB_CONCURRENCY: 1 })).toEqual([]);
    expect(warnings({ ...base, WEB_CONCURRENCY: 4, REDIS_URL: "redis://x" })).toEqual([]);
    const w = warnings({ ...base, WEB_CONCURRENCY: 4 });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/REDIS_URL/);
    expect(w[0]).toMatch(/4 workers/);
  });
});

describe("the system check does not say 'working' when it is not (audited 2026-11-15)", () => {
  // A dead tunnel is the commonest way calls stop arriving, and ngrok answers a dead tunnel with a 404 page.
  it.each([[404, "a tunnel that is down"], [502, "a bad gateway"], [503, "unavailable"], [500, "an error"]])(
    "the phone server is not 'reachable' just because something answered %i (%s)", async (status) => {
      const b = await owner();
      fakes.voice.reply = { status, body: "ERR_NGROK_3200 The endpoint is offline" };
      const c = by(await b.get("/api/system/health"), "phone_server");
      expect(c.ok).toBe(false);
      expect(c.detail).toMatch(/phone server|tunnel/i);
    });

  it.each([[403, "refused an unsigned request, as it should"], [400, "refused a call with no details"], [200, "answered"]])(
    "the phone server is working when it answers %i (%s)", async (status) => {
      const b = await owner();
      fakes.voice.reply = { status, body: "<Response/>" };
      expect(by(await b.get("/api/system/health"), "phone_server").ok).toBe(true);
    });

  it("Plivo with no credit is not 'working': the credentials are fine and calls would still fail", async () => {
    const b = await owner();
    await withPlivo(b);
    fakes.plivo.reply = { status: 200, body: { cash_credits: "0.00000" } };
    const c = by(await b.get("/api/system/health"), "plivo");
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/no credit|balance/i);
  });

  it("Plivo with credit says how much, and one that does not report it is still accepted, honestly", async () => {
    const b = await owner();
    await withPlivo(b);
    fakes.plivo.reply = { status: 200, body: { cash_credits: "12.50000" } };
    const withCredit = by(await b.get("/api/system/health"), "plivo");
    expect(withCredit.ok).toBe(true);
    expect(withCredit.detail).toMatch(/\$12\.50/);
    fakes.plivo.reply = { status: 200, body: {} };
    const silent = by(await b.get("/api/system/health"), "plivo");
    expect(silent.ok).toBe(true);
    expect(silent.detail).toMatch(/not reported|could not read/i);
  });

  it("the model check looks for the model the Studio actually uses, not only for a key that is accepted", async () => {
    const b = await owner();
    groqBody = JSON.stringify({ data: [{ id: "llama-3.3-70b" }, { id: "some-other-model" }] });
    const missing = by(await b.get("/api/system/health"), "model");
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain(config.GROQ_MODEL_ID);
    groqBody = JSON.stringify({ data: [{ id: config.GROQ_MODEL_ID }] });
    expect(by(await b.get("/api/system/health"), "model").ok).toBe(true);
  });

  it("and says whose key it tried: the Studio's own, not the phone server's", async () => {
    const b = await owner();
    expect(by(await b.get("/api/system/health"), "model").detail).toMatch(/Studio's/);
  });

  it("never puts a key, a token or a database address in an answer, whatever failed", async () => {
    const b = await owner();
    await withPlivo(b);
    groqStatus = 401;
    fakes.plivo.reply = { status: 401, body: { error: "bad token plivo_token_never_real" } };
    const text = JSON.stringify((await b.get("/api/system/health")).body);
    expect(text).not.toMatch(/gsk_test_key_never_real|plivo_token_never_real|postgres:\/\//);
  });
});
