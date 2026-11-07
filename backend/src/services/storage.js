// Supabase Storage, for one thing: a short-lived signed link to a call's recording.
// The bucket is private; the secret key never leaves this process and never appears
// in an error, a log line or a response.
import { config } from "../config/env.js";
import { HttpError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const SIGNED_URL_SECS = 600;
const TIMEOUT_MS = 5000;

export const recordingsConfigured = () => Boolean(config.SUPABASE_URL && config.SUPABASE_SECRET_KEY && config.SUPABASE_RECORDINGS_BUCKET);

/** { url, download_url } for an object path like 2026/11/<call_id>.opus. One attempt, 5 s. */
export async function signRecording(path, downloadName) {
  if (!recordingsConfigured()) throw new HttpError(503, "recordings are not configured");
  const base = config.SUPABASE_URL.replace(/\/+$/, "");
  const key = config.SUPABASE_SECRET_KEY;
  const object = path.split("/").map(encodeURIComponent).join("/");
  let signed;
  try {
    const r = await fetch(`${base}/storage/v1/object/sign/${encodeURIComponent(config.SUPABASE_RECORDINGS_BUCKET)}/${object}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: SIGNED_URL_SECS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`storage answered ${r.status}`);
    signed = (await r.json())?.signedURL;
    if (typeof signed !== "string" || !signed.startsWith("/object/sign/")) throw new Error("storage gave no signed link");
  } catch (err) {
    logger.warn({ reason: String(err?.message ?? err).replaceAll(key, "[redacted]").slice(0, 200) }, "could not sign a recording link");
    throw new HttpError(502, "could not prepare the recording; try again shortly");
  }
  const url = `${base}/storage/v1${signed}`;
  return { url, download_url: `${url}&download=${encodeURIComponent(downloadName)}` };
}

/** Removes one object from the bucket. true when it is gone (a 404 means it already was);
 * false when Storage refused or could not be reached, so the caller keeps the link and retries. */
export async function deleteRecording(path) {
  if (!recordingsConfigured()) return false;
  const base = config.SUPABASE_URL.replace(/\/+$/, "");
  const key = config.SUPABASE_SECRET_KEY;
  const object = path.split("/").map(encodeURIComponent).join("/");
  try {
    const r = await fetch(`${base}/storage/v1/object/${encodeURIComponent(config.SUPABASE_RECORDINGS_BUCKET)}/${object}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}`, apikey: key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.ok || r.status === 404) return true;
    throw new Error(`storage answered ${r.status}`);
  } catch (err) {
    logger.warn({ reason: String(err?.message ?? err).replaceAll(key, "[redacted]").slice(0, 200) }, "could not delete an expired recording");
    return false;
  }
}
