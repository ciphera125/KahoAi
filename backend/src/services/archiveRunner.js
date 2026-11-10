// Files the platform's records in Storage on a timer (see archive.js). Same advisory-lock pattern
// as the other runners, so several workers never file the same day twice at once.
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import { logger } from "../utils/logger.js";
import { archiveOnce } from "./archive.js";
import { archiveUsers } from "./archiveUsers.js";

const LOCK = 727278;
let timer = null;
let busy = false;

export async function runLocked() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK]);
    if (!rows[0].ok) return null;
    try { const r = await archiveOnce(); const u = await archiveUsers(); return { filed: r.filed + u.filed, failed: r.failed + u.failed }; } finally { await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {}); }
  } finally { client.release(); }
}

export function startArchiveRunner() {
  if (timer) return;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await runLocked(); } catch (err) { logger.error({ err: err.message }, "archive runner failed; trying again on the next tick"); } finally { busy = false; }
  };
  setTimeout(tick, 5000).unref(); // soon after start, so a restart never leaves a gap
  timer = setInterval(tick, config.ARCHIVE_INTERVAL_MS);
  timer.unref();
}

export function stopArchiveRunner() { clearInterval(timer); timer = null; }
