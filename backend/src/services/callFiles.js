// A call's files in Supabase Storage, named so a person can find them.
//
// The voice service uploads a recording as `2026/11/<call id>.opus`, the only name it can know.
// The Studio then files it in `1-recordings/2026-11-08_1555_99999999.opus` and writes the
// transcript as `2-transcripts/2026-11-08_1555_99999999.txt`: the same name in two simple
// folders, so a recording and its words are easy to find. The name carries no person, and the
// transcript has no name, phone number or e-mail in it (redact.js).
//
// Best effort, off the call path, and safe to run any number of times: it never throws, and a
// failure leaves things exactly as they were so the next run can try again.
import { asSystem } from "../db/pool.js";
import { logger } from "../utils/logger.js";
import * as Call from "../models/Call.js";
import * as CallAnswer from "../models/CallAnswer.js";
import { redactPII } from "../models/redact.js";
import { fileStem, transcriptText } from "../models/transcriptText.js";
import { moveRecording, putText, recordingsConfigured } from "./storage.js";

const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const RECORDINGS = "1-recordings";
export const TRANSCRIPTS = "2-transcripts";

export async function publishCallFiles(callId) {
  try {
    if (!recordingsConfigured() || !CALL_ID.test(String(callId))) return;
    const call = await asSystem((db) => db.query(
      "SELECT org_id, recording_path, transcript_path, has_transcript, ended_at FROM calls WHERE call_id = $1", [callId]));
    const row = call.rows[0];
    if (!row?.org_id) return;
    const org = row.org_id;

    const meta = await Call.forFiles(org, callId);
    // Nothing about the person is in a name in Storage: the day, the time and a short id are enough.
    const stem = fileStem({ startedAt: meta.startedAt, callId, anonymous: true });

    if (row.recording_path) {
      const ext = row.recording_path.endsWith(".wav") ? "wav" : "opus";
      const to = `${RECORDINGS}/${stem}.${ext}`;
      if (row.recording_path !== to && await moveRecording(row.recording_path, to)) {
        await asSystem((db) => db.query("UPDATE calls SET recording_path = $2 WHERE call_id = $1 AND recording_path = $3",
          [callId, to, row.recording_path]));
      }
    }

    if (row.has_transcript) {
      const [turns, answers] = await Promise.all([Call.turns(org, callId), CallAnswer.forCall(org, callId)]);
      const path = `${TRANSCRIPTS}/${stem}.txt`;
      const text = redactPII(transcriptText({ ...meta, name: null, peer: null, turns, answers, anonymous: true }), { names: [meta.name] });
      if (await putText(path, text)) {
        await asSystem((db) => db.query("UPDATE calls SET transcript_path = $2 WHERE call_id = $1", [callId, path]));
      }
    }
  } catch (err) {
    logger.warn({ err: String(err?.message ?? err).slice(0, 200) }, "could not save a call's files");
  }
}
