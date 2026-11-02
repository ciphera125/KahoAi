// Keeps the Dashboard's call outcomes current without a "Sync with Plivo"
// button: a background pass, same advisory-lock pattern as bulkRunner.js, so
// several worker processes never race each other to do it twice.
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import * as Call from "../models/Call.js";
import * as PhoneNumber from "../models/PhoneNumber.js";
import { syncFromPlivo } from "./plivoSync.js";
import { logger } from "../utils/logger.js";

const LOCK = 727276;

/** One pass over every organization with a Plivo number. Safe to call at any
 * time; tests call it directly. A sync failure for one organization (bad
 * credentials, Plivo unreachable) never stops the rest. */
export async function runOnce() {
  for (const orgId of await PhoneNumber.orgsWithPlivo()) {
    try {
      const [authId, authToken] = await PhoneNumber.plivoCredentials(orgId);
      if (!authId || !authToken) continue;
      const ours = (await PhoneNumber.listPublic(orgId)).find((n) => n.provider === "plivo")?.number ?? null;
      await syncFromPlivo({ authId, authToken, ours,
        onRecord: (id, fields) => Call.recordOutcome(id, fields, { orgId }) });
    } catch (err) {
      logger.warn({ err: err.message, orgId }, "automatic Plivo sync failed for this organization; trying again next pass");
    }
  }
}

let timer = null;
let busy = false;

export function startPlivoSyncRunner() {
  if (timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    const client = await pool.connect().catch(() => null);
    try {
      if (!client) return;
      const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK]);
      if (!rows[0].ok) return;
      try {
        await runOnce();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
      }
    } catch (err) {
      logger.error({ err: err.message }, "Plivo sync runner failed; trying again on the next tick");
    } finally {
      client?.release();
      busy = false;
    }
  }, config.PLIVO_SYNC_INTERVAL_MS);
  timer.unref();
}

export function stopPlivoSyncRunner() {
  clearInterval(timer);
  timer = null;
}
