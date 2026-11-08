import { createHmac } from "node:crypto";
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, member, owner } from "./helpers.js";

let server, port, received, reply;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { received.push({ headers: req.headers, body }); res.statusCode = reply; res.end("ok"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
afterAll(() => server.close());
beforeEach(async () => { await freshDb(); received = []; reply = 200; });

const hook = () => `http://127.0.0.1:${port}/done`;
const finish = async (id, agentId, summary = "Will pay on Friday.") => {
  await internal("put", `/internal/v1/calls/${id}`).send({ agent_id: agentId, direction: "outbound" });
  await internal("post", `/internal/v1/calls/${id}/events`).send({ events: [
    { event: "call_start", at: Date.now() / 1000 }, { event: "summary", summary, at: Date.now() / 1000 + 5 }] });
};
const waitFor = async (fn) => { for (let i = 0; i < 60 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); };
async function setup() {
  const b = await owner();
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  return { b, a };
}

describe("the call-finished webhook", () => {
  it("is set in Settings, and the signing secret is shown once", async () => {
    const { b } = await setup();
    const r = await b.patch("/api/org/settings").send({ webhook_url: hook() });
    expect(r.status).toBe(200);
    expect(r.body.webhook_url).toBe(hook());
    expect(r.body.webhook_secret).toMatch(/^whsec_[0-9a-f]{32}$/);
    const again = (await b.get("/api/org/settings")).body;
    expect(again.webhook_url).toBe(hook());
    expect(again.webhook_secret).toBeUndefined();
    expect(again.webhook_secret_set).toBe(true);
  });

  it("sends the outcome, summary and saved answers once when a call finishes, signed", async () => {
    const { b, a } = await setup();
    const { webhook_secret: secret } = (await b.patch("/api/org/settings").send({ webhook_url: hook() })).body;
    await finish("call-wh-1", a.id);
    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    const sent = JSON.parse(body);
    expect(sent).toMatchObject({ event: "call.completed", call_id: "call-wh-1", agent_id: a.id, direction: "outbound",
      summary: "Will pay on Friday.", answers: [] });
    const stamp = headers["x-kaho-timestamp"];
    expect(stamp).toMatch(/^\d+$/);
    const expected = createHmac("sha256", secret).update(`${stamp}.${body}`).digest("hex");
    expect(headers["x-kaho-signature"]).toBe(`sha256=${expected}`);
    // the same call finishing again does not send it again
    await finish("call-wh-1", a.id, "Will pay on Friday.");
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(1);
  });

  it("sends nothing when no webhook is set", async () => {
    const { a } = await setup();
    await finish("call-wh-2", a.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0);
  });

  it("refuses an address on a private network", async () => {
    const { b } = await setup();
    const r = await b.patch("/api/org/settings").send({ webhook_url: "https://169.254.169.254/x" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/private network/);
  });

  it("a webhook that fails never breaks the call, and the failure is visible in notifications", async () => {
    const { b, a } = await setup();
    await b.patch("/api/org/settings").send({ webhook_url: hook() });
    reply = 500;
    await finish("call-wh-3", a.id);
    await waitFor(() => received.length > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect((await db.query("SELECT 1 FROM calls WHERE call_id = 'call-wh-3'")).rowCount).toBe(1);
    const feed = (await b.get("/api/notifications")).body;
    expect(JSON.stringify(feed)).toMatch(/webhook/i);
  });

  it("can be turned off, and the secret can be replaced", async () => {
    const { b, a } = await setup();
    const first = (await b.patch("/api/org/settings").send({ webhook_url: hook() })).body.webhook_secret;
    const second = (await b.patch("/api/org/settings").send({ rotate_webhook_secret: true })).body.webhook_secret;
    expect(second).not.toBe(first);
    await b.patch("/api/org/settings").send({ webhook_url: null });
    await finish("call-wh-4", a.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0);
  });

  it("is for those who may change organization settings", async () => {
    const { b } = await setup();
    const v = await member(b, { email: "v@acme.in", name: "V" });
    expect((await v.patch("/api/org/settings").send({ webhook_url: hook() })).status).toBe(403);
  });
});
