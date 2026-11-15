// The month turning over, on a timer: plans whose month is out are ended, and a plan three days from its
// end says so, each once. Same advisory-lock pattern as the other runners, so several workers never do it twice.
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import * as Billing from "../models/Billing.js";
import { logger } from "../utils/logger.js";

const LOCK = 727279;
let timer = null;
let busy = false;

/** One pass under the lock. Returns what it did, or null when another process holds the lock. */
export async function runLocked(now = new Date()) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK]);
    if (!rows[0].ok) return null;
    try { return await Billing.expireDue(now); } finally { await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {}); }
  } finally { client.release(); }
}

export function startBillingRunner() {
  if (timer) return;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await runLocked();
      if (r && (r.expired.length || r.reminded.length)) logger.info({ expired: r.expired.length, reminded: r.reminded.length }, "plans checked");
    } catch (err) { logger.error({ err: err.message }, "billing runner failed; trying again on the next tick"); } finally { busy = false; }
  };
  setTimeout(tick, 10_000).unref();
  timer = setInterval(tick, config.BILLING_INTERVAL_MS);
  timer.unref();
}

export function stopBillingRunner() { clearInterval(timer); timer = null; }
