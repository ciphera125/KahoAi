import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, member, owner } from "./helpers.js";
import { config } from "../src/config/env.js";
import { startFakes } from "./fakes.js";

let fakes, groq, storage, groqStatus, storageStatus;
beforeAll(async () => {
  fakes = await startFakes();
  const mk = (port, handle) => new Promise((resolve) => { const s = http.createServer(handle); s.listen(port, "127.0.0.1", () => resolve(s)); });
  groq = await mk(18768, (req, res) => { res.writeHead(groqStatus, { "Content-Type": "application/json" }); res.end("{}"); });
  storage = await mk(18767, (req, res) => { req.resume(); req.on("end", () => { res.writeHead(storageStatus); res.end("{}"); }); });
});
afterAll(async () => { await fakes.close(); await Promise.all([groq, storage].map((s) => new Promise((r) => s.close(r)))); });
const saved = { ...config };
beforeEach(async () => {
  await freshDb();
  groqStatus = 200; storageStatus = 200;
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
    expect(r.body.checks.map((c) => c.id)).toEqual(["database", "model", "storage", "plivo", "phone_server"]);
    expect(r.body.checks.every((c) => c.ok)).toBe(true);
    expect(r.body.ok).toBe(true);
    expect(fakes.plivo.requests.some((x) => x.method === "GET" && x.url.startsWith("/v1/Account/MAXXXXXXXXXXXXXXXXXX/"))).toBe(true);
    expect(fakes.voice.requests.length).toBeGreaterThan(0);
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
