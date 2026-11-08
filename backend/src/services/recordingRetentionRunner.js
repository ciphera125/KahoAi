// RECORDING_RETENTION_DAYS for the cloud copies: the phone server deletes its local WAV
// after that many days; this deletes the Supabase Storage object and unlinks it from the
// call. Same advisory-lock pattern as plivoSyncRunner.js, so several workers never race.
import { config } from "../config/env.js";
import { pool, systemQuery } from "../db/pool.js";
import { deleteRecording, recordingsConfigured } from "./storage.js";
import { logger } from "../utils/logger.js";

const LOCK = 727277;
const BATCH = 200;

/** One pass. Only the link is cleared after Storage confirmed the delete; a failure leaves
 * the row for the next pass and never stops the others. Returns how many were deleted. */
export async function runOnce({ days = config.RECORDING_RETENTION_DAYS } = {}) {
  if (!recordingsConfigured()) return 0;
  const { rows } = await systemQuery(
    `SELECT call_id, recording_path, transcript_path FROM calls
      WHERE recording_path IS NOT NULL AND recording_at < now() - ($1 * interval '1 day')
      ORDER BY recording_at LIMIT ${BATCH}`, [days]);
  let deleted = 0;
  for (const { call_id: id, recording_path: path, transcript_path: transcript } of rows) {
    if (!(await deleteRecording(path))) continue;
    // The transcript saved beside it goes with it. If that one cannot be deleted now it is
    // kept linked, and the pass that finds it again is the one that retries.
    const transcriptGone = !transcript || (await deleteRecording(transcript));
    await systemQuery(
      `UPDATE calls SET recording_path = NULL, recording_bytes = NULL, recording_mime = NULL, recording_at = NULL,
         transcript_path = CASE WHEN $3 THEN NULL ELSE transcript_path END
       WHERE call_id = $1 AND recording_path = $2`,
      [id, path, transcriptGone]);
    deleted++;
  }
  if (deleted) logger.info({ deleted }, "expired call recordings deleted from Storage");
  return deleted;
}

let timer = null;
let busy = false;

export function startRecordingRetentionRunner() {
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
      logger.error({ err: err.message }, "recording retention runner failed; trying again on the next tick");
    } finally {
      client?.release();
      busy = false;
    }
  }, config.RECORDING_RETENTION_INTERVAL_MS);
  timer.unref();
}

export function stopRecordingRetentionRunner() {
  clearInterval(timer);
  timer = null;
}
