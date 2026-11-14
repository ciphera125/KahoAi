// The database can only serve so many connections. These tests hold the line on three things: the
// numbers are compared with what the server allows (before real traffic, not during it), a busy
// pool answers "try again in a moment" instead of "something went wrong", and the System check says
// how full the pool is.
import { describe, expect, it } from "vitest";
import { connectionBudget } from "../src/services/startup.js";
import { errorHandler } from "../src/middleware/errors.js";
import { pool, poolUsage } from "../src/db/pool.js";
import { freshDb, owner } from "./helpers.js";

describe("connectionBudget", () => {
  const base = { perWorker: 10, workers: 1, serverMax: 100, reserved: 3, usedByOthers: 5 };

  it("is fine when what we can open fits in what the server has left", () => {
    const r = connectionBudget(base);
    expect(r.ok).toBe(true);
    expect(r.need).toBe(13); // 10 for requests + 1 for the runner's lock, + 2 for start-up work
    expect(r.available).toBe(92);
  });

  it("counts every worker: 4 workers of 10 need 4 x 11 + 2", () => {
    expect(connectionBudget({ ...base, workers: 4 }).need).toBe(46);
  });

  it("warns, in plain words with the numbers, when it does not fit", () => {
    const r = connectionBudget({ ...base, workers: 8, serverMax: 60 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/PGPOOL_MAX/);
    expect(r.message).toMatch(/90/); // 8 x 11 + 2
    expect(r.message).toMatch(/52/); // 60 - 3 - 5
  });

  it("leaves a margin: using more than 80% of what is left is a warning too", () => {
    const r = connectionBudget({ ...base, workers: 1, perWorker: 75, serverMax: 100 });
    expect(r.need).toBe(78); // of 92 left: more than 80%
    expect(r.ok).toBe(false);
  });

  it("an unreadable server answer is no warning, not a crash", () => {
    expect(connectionBudget({ ...base, serverMax: NaN }).ok).toBe(true);
    expect(connectionBudget({ ...base, serverMax: NaN }).skipped).toBe(true);
  });
});

describe("a database that is busy answers 503 with a retry hint, not a bare failure", () => {
  const run = (err) => {
    const res = { headers: {}, statusCode: null, body: null, headersSent: false,
      set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    errorHandler(err, { id: "r1" }, res, () => {});
    return res;
  };

  it.each([
    ["no connection free in time", new Error("timeout exceeded when trying to connect")],
    ["too many connections", Object.assign(new Error("sorry, too many clients already"), { code: "53300" })],
    ["a statement ran out of time", Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })],
    ["the pool is closed for a shutdown", new Error("Cannot use a pool after calling end on the pool")],
  ])("%s", (_name, err) => {
    const res = run(err);
    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("2");
    expect(res.body.error).toMatch(/busy/i);
    expect(JSON.stringify(res.body)).not.toMatch(/53300|57014|clients|pool|statement/);
  });

  it("an ordinary failure is still a 500 with the plain message", () => {
    const res = run(new Error("boom"));
    expect(res.statusCode).toBe(500);
    expect(res.headers["Retry-After"]).toBeUndefined();
  });
});

describe("poolUsage", () => {
  it("reports how full the pool is", () => {
    const u = poolUsage();
    expect(u).toMatchObject({ max: expect.any(Number), open: expect.any(Number), idle: expect.any(Number), waiting: expect.any(Number) });
    expect(u.max).toBeGreaterThanOrEqual(1);
  });
});

describe("a real request while every database connection is taken", () => {
  it("is answered 503 with a retry hint within the connection deadline, and works again once connections free up", async () => {
    await freshDb();
    const b = await owner();
    const held = [];
    for (let i = 0; i < pool.options.max; i++) held.push(await pool.connect());
    const t = Date.now();
    const r = await b.get("/api/agents");
    const took = Date.now() - t;
    for (const c of held) c.release();
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBe("2");
    expect(r.body.error).toMatch(/busy/i);
    expect(took).toBeLessThan(8000); // never a hang
    expect((await b.get("/api/agents")).status).toBe(200);
  }, 20000);
});
