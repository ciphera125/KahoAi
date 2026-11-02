import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb, owner, db } from "./helpers.js";
import { startFakes } from "./fakes.js";
import { runOnce } from "../src/services/plivoSyncRunner.js";

let fakes;
beforeAll(async () => { fakes = await startFakes(); });
afterAll(() => fakes.close());
beforeEach(async () => {
  await freshDb();
  fakes.plivo.cdrs = [];
});

describe("automatic Plivo sync (replaces the manual 'Sync with Plivo' button)", () => {
  it("reconciles every organization with Plivo credentials, with no button click", async () => {
    const b = await owner();
    await b.post("/api/numbers").send({ provider: "plivo", number: "+918065520552",
      credentials: { auth_id: "MAID123", auth_token: "plivo-token" } });
    fakes.plivo.cdrs = [{ call_uuid: "cdr-auto-0001", call_direction: "outbound", from_number: "918065520552",
      to_number: "919876543210", call_state: "completed", hangup_cause_name: "Normal Hangup", bill_duration: 12,
      total_amount: "0.24", initiation_time: "2026-10-20 10:00:00+05:30" }];
    await runOnce();
    const { rows } = await db.query("SELECT status, peer, duration_secs FROM calls WHERE call_id = 'cdr-auto-0001'");
    expect(rows[0]).toEqual({ status: "answered", peer: "+919876543210", duration_secs: 12 });
  });

  it("skips organizations with no Plivo credentials, without failing the pass", async () => {
    await owner();
    await expect(runOnce()).resolves.not.toThrow();
  });
});
