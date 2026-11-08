import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal, line, owner, publish, OURS } from "./helpers.js";
import { config } from "../src/config/env.js";
import { publishCallFiles } from "../src/services/callFiles.js";
import { runOnce } from "../src/services/recordingRetentionRunner.js";

// The Storage the Studio talks to (127.0.0.1:18767, see setup-env.js): this one keeps what it
// was asked to do, and answers like the real one does.
let fake, log, refuse;
beforeAll(async () => {
  fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      log.push({ method: req.method, url: req.url, type: req.headers["content-type"], body,
        auth: req.headers.authorization });
      if (refuse) { res.writeHead(500); return res.end("{}"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      // Signing answers with a link, as the real one does; everything else with nothing.
      res.end(req.url.includes("/object/sign/") ? JSON.stringify({ signedURL: `/object/sign/${req.url.split("/sign/")[1]}?token=t` }) : "{}");
    });
  });
  await new Promise((r) => fake.listen(18767, "127.0.0.1", r));
});
afterAll(() => new Promise((r) => fake.close(r)));
beforeEach(async () => { await freshDb(); log = []; refuse = false; });

const CALL = "99999999-9999-9999-9999-999999999999";
const BUCKET = "/storage/v1/object/call-recordings";
const NAMED = "2026/11/Ravi-Kumar_2026-11-08_1555_99999999";

async function aFinishedCall(b, { name = "Ravi Kumar", recorded = true } = {}) {
  await line(b);
  await b.post("/api/contacts").send({ name, numbers: ["+919876543210"] });
  const a = (await b.post("/api/agents").send({ name: "Ria", prompt: "You are Ria." })).body;
  await publish(b, a.id).catch(() => {});
  await internal("put", `/internal/v1/calls/${CALL}`).send({ status: "answered", peer: "+919876543210", ours: OURS, agent_id: a.id });
  await internal("post", `/internal/v1/calls/${CALL}/events`).send({ events: [
    { event: "call_start", at: "2026-11-08T10:25:00.000Z" },
    { event: "turn", role: "assistant", text: "Hello, this is Ria.", at: "2026-11-08T10:25:12.000Z" },
    { event: "turn", role: "user", text: "Hi", at: "2026-11-08T10:25:20.000Z" },
    { event: "call_end", at: "2026-11-08T10:28:20.000Z" },
  ] });
  if (recorded) {
    await internal("post", `/internal/v1/calls/${CALL}/recording`).send({ path: `2026/11/${CALL}.opus`, bytes: 6000, mime: "audio/opus" });
  }
  log = [];
  return a;
}
const row = async () => (await db.query("SELECT recording_path, transcript_path FROM calls WHERE call_id = $1", [CALL])).rows[0];

describe("a call's files in Supabase Storage", () => {
  it("renames the recording after the person, the day and the time", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await publishCallFiles(CALL);
    const move = log.find((r) => r.url === "/storage/v1/object/move");
    expect(JSON.parse(move.body)).toEqual({ bucketId: "call-recordings", sourceKey: `2026/11/${CALL}.opus`,
      destinationKey: `${NAMED}.opus` });
    expect((await row()).recording_path).toBe(`${NAMED}.opus`);
  });

  it("saves the transcript next to it, as readable text with the same name", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await publishCallFiles(CALL);
    const put = log.find((r) => r.method === "POST" && r.url === `${BUCKET}/${NAMED}.txt`);
    expect(put.type).toMatch(/^text\/plain/);
    expect(put.body).toContain("Call with Ravi Kumar");
    expect(put.body).toContain("Caller: Hi");
    expect(put.auth).toMatch(/^Bearer /);
    expect((await row()).transcript_path).toBe(`${NAMED}.txt`);
  });

  it("does the transcript alone for a call that was not recorded", async () => {
    const b = await owner();
    await aFinishedCall(b, { recorded: false });
    await publishCallFiles(CALL);
    expect(log.some((r) => r.url === "/storage/v1/object/move")).toBe(false);
    expect((await row()).transcript_path).toBe(`${NAMED}.txt`);
  });

  it("does nothing twice: a recording already under its name is left where it is", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await publishCallFiles(CALL);
    log = [];
    await publishCallFiles(CALL);
    expect(log.some((r) => r.url === "/storage/v1/object/move")).toBe(false);
  });

  it("will not name a file anything a path could misuse", async () => {
    const b = await owner();
    await aFinishedCall(b, { name: '../../etc/passwd "x"' });
    await publishCallFiles(CALL);
    const { recording_path: path } = await row();
    expect(path).toMatch(/^2026\/11\/[A-Za-z0-9_-]+\.opus$/);
    expect(path).not.toContain("..");
  });

  it("leaves everything as it was, and does not throw, when Storage refuses", async () => {
    const b = await owner();
    await aFinishedCall(b);
    refuse = true;
    await expect(publishCallFiles(CALL)).resolves.not.toThrow();
    expect(await row()).toEqual({ recording_path: `2026/11/${CALL}.opus`, transcript_path: null });
  });

  it("does nothing, quietly, where Storage is not set up", async () => {
    const b = await owner();
    await aFinishedCall(b);
    const saved = config.SUPABASE_SECRET_KEY;
    config.SUPABASE_SECRET_KEY = "";
    try {
      await expect(publishCallFiles(CALL)).resolves.not.toThrow();
      expect(log).toEqual([]);
    } finally { config.SUPABASE_SECRET_KEY = saved; }
  });

  it("is never run for a call that is not there", async () => {
    await expect(publishCallFiles("00000000-0000-0000-0000-000000000000")).resolves.not.toThrow();
    expect(log).toEqual([]);
  });

  it("happens by itself when the voice service reports the recording", async () => {
    const b = await owner();
    await aFinishedCall(b, { recorded: false });
    await internal("post", `/internal/v1/calls/${CALL}/recording`).send({ path: `2026/11/${CALL}.opus`, bytes: 6000, mime: "audio/opus" });
    await new Promise((r) => setTimeout(r, 400));
    expect((await row()).recording_path).toBe(`${NAMED}.opus`);
  });

  it("is served under that name, and downloads as the same file name", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await publishCallFiles(CALL);
    const r = await b.get(`/api/calls/${CALL}/recording`);
    expect(r.status).toBe(200);
    expect(r.body.url).toContain(`${NAMED}.opus`);
    expect(r.body.download_url).toContain(`download=${encodeURIComponent("Ravi-Kumar_2026-11-08_1555_99999999.opus")}`);
  });
});

describe("they are deleted together", () => {
  it("the transcript goes when the recording expires", async () => {
    const b = await owner();
    await aFinishedCall(b);
    await publishCallFiles(CALL);
    await db.query("UPDATE calls SET recording_at = now() - interval '90 days' WHERE call_id = $1", [CALL]);
    log = [];
    await runOnce({ days: 60 });
    const deleted = log.filter((r) => r.method === "DELETE").map((r) => r.url);
    expect(deleted).toEqual(expect.arrayContaining([`${BUCKET}/${NAMED}.opus`, `${BUCKET}/${NAMED}.txt`]));
    expect(await row()).toEqual({ recording_path: null, transcript_path: null });
  });
});
