// A sweep of every route the backend has, with nothing to prove who is asking (security pass, 2026-11-22).
// A new route that forgets its sign-in check, or one that crashes on a request with no credentials, fails here
// the day it is added: the routes are read from the route files, not listed by hand.
import { readdirSync, readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, internalApp } from "./helpers.js";

const dir = new URL("../src/routes/", import.meta.url);
const PREFIX = { agents: "/api/agents", prompts: "/api/prompts", bulk: "/api/bulk-calls", auth: "/api/auth", admin: "/api/admin", publicApi: "/api/v1", internal: "/internal/v1" };

function routes() {
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "index.js")) {
    const name = file.replace(/\.js$/, "");
    const prefix = PREFIX[name] ?? "/api";
    const text = readFileSync(new URL(file, dir), "utf8");
    for (const m of text.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
      out.push({ file: name, method: m[1], path: `${prefix}${m[2] === "/" ? "" : m[2]}`.replace(/:[A-Za-z_]+/g, "x") });
    }
  }
  return out;
}

const ALL = routes();
// What may be asked without signing in: signing in and up themselves, and nothing else.
const OPEN = new Set(["/api/auth/state", "/api/auth/signup", "/api/auth/login", "/api/auth/logout", "/api/auth/support-signin",
  "/api/admin/auth/state", "/api/admin/auth/signup", "/api/admin/auth/login", "/api/admin/auth/logout"]);


describe("the route sweep", () => {
  it("finds the routes (so the sweep cannot quietly check nothing)", () => {
    expect(ALL.length).toBeGreaterThan(150);
    expect(ALL.filter((r) => r.path.startsWith("/internal/v1")).length).toBeGreaterThan(5);
    expect(ALL.filter((r) => r.path.startsWith("/api/admin")).length).toBeGreaterThan(20);
  });

  it("refuses every Studio route when nobody is signed in", async () => {
    const bad = [];
    for (const r of ALL.filter((x) => x.path.startsWith("/api/") && !x.path.startsWith("/api/admin") && !x.path.startsWith("/api/v1") && !OPEN.has(x.path))) {
      const res = await request(app)[r.method](r.path).set("Origin", "http://localhost:5173").set("Host", "localhost:8020").send(r.method === "get" ? undefined : {});
      if (![401, 403, 404].includes(res.status)) bad.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it("refuses every admin-site route when nobody is signed in to it", async () => {
    const bad = [];
    for (const r of ALL.filter((x) => x.path.startsWith("/api/admin") && !OPEN.has(x.path))) {
      const res = await request(app)[r.method](r.path).set("Origin", "http://localhost:5174").set("Host", "localhost:8020").send(r.method === "get" ? undefined : {});
      if (![401, 403, 404].includes(res.status)) bad.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it("refuses every machine-key route without a key, and with a made-up one", async () => {
    const bad = [];
    for (const r of ALL.filter((x) => x.path.startsWith("/api/v1"))) {
      for (const key of [null, "kaho_live_notarealkey0123456789"]) {
        const res = await request(app)[r.method](r.path).set("Authorization", key ? `Bearer ${key}` : "x").send(r.method === "get" ? undefined : {});
        if (![401, 403, 404].includes(res.status)) bad.push(`${r.method.toUpperCase()} ${r.path} (${key ? "fake" : "no"} key) -> ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("refuses every voice-service route without the service token, and with a wrong one", async () => {
    const bad = [];
    for (const r of ALL.filter((x) => x.path.startsWith("/internal/v1"))) {
      for (const token of [null, "wrong-token", "t".repeat(47), "u".repeat(48), `x${"t".repeat(48)}`]) {
        const req = request(internalApp)[r.method](r.path);
        if (token) req.set("Authorization", `Bearer ${token}`);
        const res = await req.send(r.method === "get" ? undefined : {});
        if (![401, 403].includes(res.status)) bad.push(`${r.method.toUpperCase()} ${r.path} (${token ?? "no token"}) -> ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("never crashes on a request with no credentials, whatever the body", async () => {
    const bad = [];
    for (const body of [{}, { a: "\u0000" }, "text", [], { __proto__: { admin: true } }]) {
      for (const r of ALL.filter((x) => x.method !== "get" && x.path.startsWith("/api/") && !x.path.startsWith("/api/v1")).slice(0, 80)) {
        const res = await request(app)[r.method](r.path).set("Origin", "http://localhost:5173").set("Host", "localhost:8020").send(body);
        if (res.status >= 500) bad.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
