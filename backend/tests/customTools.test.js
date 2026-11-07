import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, line, member, owner, publish, OURS } from "./helpers.js";
import { isPrivateAddress, pick, urlProblem } from "../src/models/outbound.js";
import * as Agent from "../src/models/Agent.js";

beforeEach(freshDb);

// Somebody else's API, on this machine. Localhost is allowed outside production.
let api, seen, answer;
beforeAll(async () => {
  api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      const [status, payload] = answer(req, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => api.listen(18791, "127.0.0.1", r));
});
afterAll(() => new Promise((r) => api.close(r)));
beforeEach(() => { seen = []; answer = () => [200, { status: "shipped", order: { id: "A1" } }]; });

const BASE = "http://127.0.0.1:18791";
const DEF = {
  label: "Check order status",
  description: "Use when the caller asks where their order is.",
  method: "POST",
  url: `${BASE}/orders`,
  headers: { Authorization: "Bearer super-secret-token" },
  body_template: '{"order_id": "{{input.order_number}}"}',
  inputs: [{ label: "Order number", type: "text", required: true, example: "A1" }],
  say_while_waiting: "One moment, let me check.",
  extract: { order_status: "$.status" },
};
const make = (b, body = {}) => b.post("/api/custom-tools").send({ ...DEF, ...body });

describe("addresses we refuse to call", () => {
  it("knows a private address when it sees one", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "172.16.0.1", "::1", "fd00::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("insists on https, and refuses the metadata service outright", () => {
    expect(urlProblem("https://api.example.com/x")).toBeNull();
    expect(urlProblem("ftp://example.com")).toMatch(/https/);
    expect(urlProblem("http://api.example.com")).toMatch(/https/);
    expect(urlProblem("https://169.254.169.254/latest/meta-data/")).toMatch(/private network/);
    expect(urlProblem("https://10.0.0.1/admin")).toMatch(/private network/);
    expect(urlProblem("not a url")).toMatch(/web address/);
  });

  it("refuses to save a tool pointing at one", async () => {
    const b = await owner();
    const r = await make(b, { url: "https://169.254.169.254/latest/meta-data/" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/private network/);
  });
});

describe("pulling one value out of an answer", () => {
  it("reads a path, an array and a missing one", () => {
    const body = { status: "shipped", items: [{ sku: "A" }, { sku: "B" }], deep: { a: { b: 2 } } };
    expect(pick(body, "$.status")).toBe("shipped");
    expect(pick(body, "$.items[1].sku")).toBe("B");
    expect(pick(body, "$.deep.a.b")).toBe(2);
    expect(pick(body, "$.nope.deeper")).toBeUndefined();
    expect(pick(null, "$.status")).toBeUndefined();
  });
});

describe("defining a tool", () => {
  it("gives it a machine name from the label and keeps the secret out of sight", async () => {
    const b = await owner();
    const r = await make(b);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "check_order_status", label: "Check order status" });
    expect(JSON.stringify(r.body)).not.toContain("super-secret-token");
    expect(r.body.headers.Authorization).toBe("••••••••");

    const { rows } = await db.query("SELECT headers_sealed FROM custom_tools");
    expect(rows[0].headers_sealed).not.toContain("super-secret-token");
  });

  it("keeps the machine name when the label is changed", async () => {
    const b = await owner();
    const made = (await make(b)).body;
    const renamed = await b.patch(`/api/custom-tools/${made.id}`).send({ label: "Order status check" });
    expect(renamed.body.name).toBe("check_order_status");
    expect(renamed.body.label).toBe("Order status check");
  });

  it("keeps the saved headers when they are not sent again", async () => {
    const b = await owner();
    const made = (await make(b)).body;
    await b.patch(`/api/custom-tools/${made.id}`).send({ description: "Changed" });
    const { rows } = await db.query("SELECT headers_sealed FROM custom_tools");
    expect(rows[0].headers_sealed).toBeTruthy();
    const ran = await b.post(`/api/custom-tools/${made.id}/test`).send({});
    expect(seen[0].headers.authorization).toBe("Bearer super-secret-token");
    expect(ran.body.ok).toBe(true);
  });

  it("refuses two tools with the same name, and a nameless one", async () => {
    const b = await owner();
    await make(b);
    expect((await make(b)).status).toBe(400);
    expect((await make(b, { label: "!!" })).status).toBe(400);
  });

  it("is only an admin's to make or delete", async () => {
    const b = await owner();
    const m = await member(b);
    expect((await m.post("/api/custom-tools").send(DEF)).status).toBe(403);
  });
});

describe("testing one from the Studio", () => {
  it("sends the request and shows what came back", async () => {
    const b = await owner();
    const made = (await make(b)).body;
    const r = await b.post(`/api/custom-tools/${made.id}/test`).send({ order_number: "A1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 200 });
    expect(r.body.kept).toEqual({ order_status: "shipped" });
    expect(seen[0].body).toBe('{"order_id": "A1"}');

    const after = (await b.get("/api/custom-tools")).body[0];
    expect(after.last_test_ok).toBe(true);
    expect(after.last_test_at).toBeTruthy();
  });

  it("records a failure in words the person can act on", async () => {
    const b = await owner();
    const made = (await make(b)).body;
    answer = () => [500, { error: "boom" }];
    const r = await b.post(`/api/custom-tools/${made.id}/test`).send({ order_number: "A1" });
    expect(r.body.ok).toBe(false);
    expect(r.body.note).toContain("500");
    expect((await b.get("/api/custom-tools")).body[0].last_test_ok).toBe(false);
  });
});

describe("an agent using one on a call", () => {
  const CALL = "55555555-5555-5555-5555-555555555555";

  async function onACall(b) {
    const tool = (await make(b)).body;
    await line(b);
    await b.post("/api/contacts").send({ name: "Ravi", numbers: ["+919876543210"] });
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    const attached = await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call", tool.name] });
    expect(attached.status).toBe(200);
    await publish(b, a.id);
    await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: "+919876543210", ours: OURS });
    return { tool, agent: a };
  }
  const run = (name, body) => internal("post", `/internal/v1/calls/${CALL}/tools/custom/${name}`).send(body);

  it("can be attached to an agent like any other tool", async () => {
    const b = await owner();
    const { agent } = await onACall(b);
    const cfg = await Agent.callConfig(agent.id);
    expect(cfg.tools).toContain("check_order_status");
    expect(cfg.custom_tools.map((t) => t.name)).toEqual(["check_order_status"]);
  });

  it("tells the voice service what to collect, and nothing about the address or the key", async () => {
    const b = await owner();
    const { agent } = await onACall(b);
    const cfg = await Agent.callConfig(agent.id);
    const sent = JSON.stringify(cfg.custom_tools);
    expect(sent).toContain("order_number");
    expect(sent).toContain("One moment, let me check.");
    expect(sent).not.toContain("super-secret-token");
    expect(sent).not.toContain("18791");
  });

  it("calls the API and hands back only what was asked for", async () => {
    const b = await owner();
    await onACall(b);
    const r = await run("check_order_status", { values: { order_number: "A1" }, turn: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, values: { order_status: "shipped" } });
    expect(seen).toHaveLength(1);
  });

  it("what the caller said cannot change the shape of the request", async () => {
    const b = await owner();
    await onACall(b);
    await run("check_order_status", { values: { order_number: 'A1", "admin": true' }, turn: 1 });
    const sent = JSON.parse(seen[0].body);
    expect(Object.keys(sent)).toEqual(["order_id"]);
    expect(sent.order_id).toBe('A1", "admin": true');
  });

  it("says something sayable when the API is down, and never why", async () => {
    const b = await owner();
    await onACall(b);
    answer = () => [500, { error: "stack trace with https://secret.internal/path" }];
    const r = await run("check_order_status", { values: { order_number: "A1" }, turn: 1 });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).not.toContain("secret.internal");
    expect(r.body.message).not.toContain("500");
  });

  it("asks for a missing answer rather than calling with nothing", async () => {
    const b = await owner();
    await onACall(b);
    const r = await run("check_order_status", { values: {}, turn: 1 });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toMatch(/order number/i);
    expect(seen).toHaveLength(0);
  });

  it("cannot be run by a call in another organization", async () => {
    const b = await owner();
    await onACall(b);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    await line(other).catch(() => {});
    const r = await internal("post", "/internal/v1/calls/66666666-6666-6666-6666-666666666666/tools/custom/check_order_status")
      .send({ values: { order_number: "A1" }, turn: 1 });
    expect(r.body.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe("a customer's own tool, from the agent's page", () => {
  it("is listed beside the built-in ones, so it can be attached", async () => {
    const b = await owner();
    await make(b);
    const r = await b.get("/api/tools");
    const names = r.body.map((t) => t.name);
    expect(names).toContain("end_call");
    expect(names).toContain("check_order_status");
    const own = r.body.find((t) => t.name === "check_order_status");
    expect(own).toMatchObject({ label: "Check order status", ready: true, custom: true });
    expect(own.description).toMatch(/where their order is/);
  });

  it("is not listed for another organization", async () => {
    const b = await owner();
    await make(b);
    const other = await owner({ email: "zoya@other.in", organization: "Other" });
    expect((await other.get("/api/tools")).body.map((t) => t.name)).not.toContain("check_order_status");
  });

  it("a prompt naming it before it is attached is told to attach it, not that it does not exist", async () => {
    const b = await owner();
    await make(b);
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    const saved = await b.patch(`/api/prompts/${a.active_prompt_id}`)
      .send({ text: "When they ask about an order, use check_order_status." });
    const [warning] = saved.body.warnings;
    expect(warning.message).toContain("Check order status");
    expect(warning.message).toMatch(/attach/i);
    expect(warning.message).not.toMatch(/no such tool/i);
  });

  it("the same prompt is fine once it is attached", async () => {
    const b = await owner();
    await make(b);
    const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
    await b.patch(`/api/agents/${a.id}`).send({ tools: ["end_call", "check_order_status"] });
    const saved = await b.patch(`/api/prompts/${a.active_prompt_id}`)
      .send({ text: "When they ask about an order, use check_order_status." });
    expect(saved.body.warnings).toEqual([]);
  });
});
