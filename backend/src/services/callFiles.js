// A call's files in Supabase Storage, named so a person can find them.
//
// The voice service uploads a recording as `2026/11/<call id>.opus`, the only name it can know.
// Once the Studio knows who the call was with, it renames that to
// `2026/11/Ravi-Kumar_2026-11-08_1555_99999999.opus` and writes the transcript beside it as
// `.txt` under the same name, so the folder in Storage shows people and times, and a transcript
// can be downloaded from the same place as its recording.
//
// Best effort, off the call path, and safe to run any number of times: it never throws, and a
// failure leaves things exactly as they were so the next run can try again.
import { asSystem } from "../db/pool.js";
import { logger } from "../utils/logger.js";
import * as Call from "../models/Call.js";
import * as CallAnswer from "../models/CallAnswer.js";
import { fileStem, transcriptText } from "../models/transcriptText.js";
import { moveRecording, putText, recordingsConfigured } from "./storage.js";

const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function publishCallFiles(callId) {
  try {
    if (!recordingsConfigured() || !CALL_ID.test(String(callId))) return;
    const call = await asSystem((db) => db.query(
      "SELECT org_id, recording_path, transcript_path, has_transcript, ended_at FROM calls WHERE call_id = $1", [callId]));
    const row = call.rows[0];
    if (!row?.org_id) return;
    const org = row.org_id;

    const meta = await Call.forFiles(org, callId);
    const stem = fileStem(meta);
    const month = `${new Date(meta.startedAt ?? Date.now()).toISOString().slice(0, 7).replace("-", "/")}`;
    // The folder is the month in India, the same one the stem's date is read in.
    const dir = meta.startedAt ? stem.split("_")[1].slice(0, 7).replace("-", "/") : month;

    if (row.recording_path) {
      const ext = row.recording_path.endsWith(".wav") ? "wav" : "opus";
      const to = `${dir}/${stem}.${ext}`;
      if (row.recording_path !== to && await moveRecording(row.recording_path, to)) {
        await asSystem((db) => db.query("UPDATE calls SET recording_path = $2 WHERE call_id = $1 AND recording_path = $3",
          [callId, to, row.recording_path]));
      }
    }

    if (row.has_transcript) {
      const [turns, answers] = await Promise.all([Call.turns(org, callId), CallAnswer.forCall(org, callId)]);
      const path = `${dir}/${stem}.txt`;
      if (await putText(path, transcriptText({ ...meta, turns, answers }))) {
        await asSystem((db) => db.query("UPDATE calls SET transcript_path = $2 WHERE call_id = $1", [callId, path]));
      }
    }
  } catch (err) {
    logger.warn({ err: String(err?.message ?? err).slice(0, 200) }, "could not save a call's files");
  }
}
