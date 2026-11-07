import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, freshDb, internal } from "./helpers.js";
import { runOnce } from "../src/services/recordingRetentionRunner.js";

// The fake Storage is the one on SUPABASE_URL (setup-env.js: 127.0.0.1:18767).
let fake, seen, answer;
beforeAll(async () => {
  fake = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.writeHead(answer(req), { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => fake.listen(18767, "127.0.0.1", r));
});
afterAll(() => new Promise((r) => fake.close(r)));
beforeEach(async () => { await freshDb(); seen = []; answer = () => 200; });

const withRecording = async (id, ageDays) => {
  await internal("put", `/internal/v1/calls/${id}`).send({ status: "answered" });
  await internal("post", `/internal/v1/calls/${id}/recording`).send({ path: `2026/11/${id}.opus`, bytes: 1000, mime: "audio/opus" });
  await db.query("UPDATE calls SET recording_at = now() - ($2 || ' days')::interval WHERE call_id = $1", [id, String(ageDays)]);
};
const row = async (id) => (await db.query("SELECT recording_path, recording_bytes, recording_mime FROM calls WHERE call_id = $1", [id])).rows[0];

describe("cloud recordings are deleted after RECORDING_RETENTION_DAYS", () => {
  it("deletes an expired recording from Storage and unlinks it from the call", async () => {
    await withRecording("old-call-1", 61);
    await runOnce({ days: 60 });
    expect(seen).toEqual(["DELETE /storage/v1/object/call-recordings/2026/11/old-call-1.opus Bearer sb_secret_test_key_never_real"]);
    expect(await row("old-call-1")).toEqual({ recording_path: null, recording_bytes: null, recording_mime: null });
  });

  it("leaves a recording that is still inside the window alone", async () => {
    await withRecording("new-call-1", 59);
    await runOnce({ days: 60 });
    expect(seen).toEqual([]);
    expect((await row("new-call-1")).recording_path).toBe("2026/11/new-call-1.opus");
  });

  it("keeps the link when Storage refuses, so the next pass tries again", async () => {
    await withRecording("old-call-2", 90);
    answer = () => 500;
    await runOnce({ days: 60 });
    expect((await row("old-call-2")).recording_path).toBe("2026/11/old-call-2.opus");
    answer = () => 200;
    await runOnce({ days: 60 });
    expect((await row("old-call-2")).recording_path).toBeNull();
  });

  it("treats an object already gone (404) as deleted", async () => {
    await withRecording("old-call-3", 90);
    answer = () => 404;
    await runOnce({ days: 60 });
    expect((await row("old-call-3")).recording_path).toBeNull();
  });

  it("one failure does not stop the rest of the pass", async () => {
    await withRecording("old-call-4", 90);
    await withRecording("old-call-5", 90);
    answer = (req) => (req.url.includes("old-call-4") ? 500 : 200);
    await runOnce({ days: 60 });
    expect((await row("old-call-4")).recording_path).not.toBeNull();
    expect((await row("old-call-5")).recording_path).toBeNull();
  });
});
