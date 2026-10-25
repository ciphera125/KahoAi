import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, browser, freshDb, internalApp, owner, ORIGIN } from "./helpers.js";

beforeEach(freshDb);

describe("request security", () => {
  it("answers health checks without a session", async () => {
    expect((await request(app).get("/healthz")).body).toEqual({ ok: true });
    const ready = await request(app).get("/readyz");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ ok: true, db: true });
  });

  it("refuses a state change from another website (CSRF)", async () => {
    const b = await owner();
    const r = await b.agent.post("/api/contacts").set("Host", "localhost:8020")
      .set("Origin", "https://evil.example").send({ name: "X" });
    expect(r.status).toBe(403);
  });

  it("refuses a state change that names no origin at all", async () => {
    const b = await owner();
    const r = await b.agent.post("/api/contacts").set("Host", "localhost:8020").send({ name: "X" });
    expect(r.status).toBe(403);
  });

  it("refuses a request that names another host (DNS rebinding)", async () => {
    const r = await request(app).get("/api/auth/state").set("Host", "attacker.example");
    expect(r.status).toBe(403);
  });

  it("refuses a body that is not JSON, and one over the size limit", async () => {
    const b = await owner();
    const form = await b.post("/api/contacts").set("Content-Type", "text/plain").send("name=x");
    expect(form.status).toBe(415);
    const big = await b.post("/api/contacts").send({ name: "x".repeat(300_000) });
    expect(big.status).toBe(413);
    const broken = await b.post("/api/contacts").set("Content-Type", "application/json").send("{oops");
    expect(broken.status).toBe(400);
  });

  it("sends security headers and no framework banner", async () => {
    const r = await request(app).get("/api/auth/state").set("Origin", ORIGIN).set("Host", "localhost:8020");
    expect(r.headers["x-powered-by"]).toBeUndefined();
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.headers["cache-control"]).toContain("no-store");
  });

  it("gives an unknown route a JSON 404, never a stack trace", async () => {
    const b = await owner();
    const r = await b.get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "not found" });
  });

  it("keeps the internal API off the public port, and shut without the service token", async () => {
    expect((await request(app).get("/internal/v1/call-config?agent_id=ag_000000000000")).status).toBe(404);
    const plain = await request(internalApp).get("/internal/v1/call-config?agent_id=ag_000000000000");
    expect(plain.status).toBe(401);
    const wrong = await request(internalApp).get("/internal/v1/call-config?agent_id=ag_000000000000")
      .set("Authorization", "Bearer wrong");
    expect(wrong.status).toBe(401);
  });

  it("rate limits sign-in attempts per address", async () => {
    const b = browser();
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await b.post("/api/auth/login").send({ email: `x${i}@y.in`, password: "wrong" });
      limited = r.status === 429;
    }
    expect(limited).toBe(true);
  });
});
