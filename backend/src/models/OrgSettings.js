// Settings that hold for the whole organization, whatever an agent says: a cap on how long any
// call can be, and the hours calls may be placed. The admin's, not the agent builder's.
import { asSystem } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "../utils/crypto.js";
import { urlProblem } from "./outbound.js";
import { checkWindow, DEFAULT_WINDOW, MAX_MINUTES } from "./Agent.js";

const shape = (stored) => ({
  max_minutes: Number.isInteger(stored?.max_minutes) ? stored.max_minutes : null,
  call_window: { ...DEFAULT_WINDOW, ...stored?.call_window },
  webhook_url: typeof stored?.webhook_url === "string" ? stored.webhook_url : null,
  webhook_secret_set: Boolean(stored?.webhook_secret_sealed),
});

const newSecret = () => `whsec_${randomBytes(16).toString("hex")}`;

/** The webhook to call when a call finishes, with its secret opened. Null when none is set. */
export async function webhookOf(orgId) {
  const { rows } = await asSystem((db) => db.query("SELECT settings FROM organizations WHERE id = $1", [orgId]));
  const s = rows[0]?.settings;
  if (!s?.webhook_url || !s.webhook_secret_sealed) return null;
  try { return { url: s.webhook_url, secret: decryptJson(s.webhook_secret_sealed).secret }; } catch { return null; }
}

export async function get(orgId) {
  const { rows } = await asSystem((db) => db.query("SELECT settings FROM organizations WHERE id = $1", [orgId]));
  if (!rows[0]) throw new NotFoundError("organization");
  return shape(rows[0].settings);
}

export async function update(orgId, changes) {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    throw new ValidationError("settings must be an object");
  }
  const { rows: [row] } = await asSystem((db) => db.query("SELECT settings FROM organizations WHERE id = $1", [orgId]));
  if (!row) throw new NotFoundError("organization");
  const current = { ...row.settings, ...(await get(orgId)) };
  const next = { ...row.settings, max_minutes: current.max_minutes, call_window: current.call_window };
  let shownSecret;
  for (const [key, value] of Object.entries(changes)) {
    if (key === "max_minutes") {
      if (value === null) next.max_minutes = null;
      else if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_MINUTES) next.max_minutes = value;
      else throw new ValidationError(`The longest call must be a whole number of minutes from 1 to ${MAX_MINUTES}, or empty for no limit`);
    } else if (key === "call_window") {
      next.call_window = checkWindow(current.call_window, value);
    } else if (key === "webhook_url") {
      if (value === null || value === "") { delete next.webhook_url; delete next.webhook_secret_sealed; }
      else {
        const url = typeof value === "string" ? value.trim().slice(0, 300) : "";
        const problem = urlProblem(url);
        if (!url || problem) throw new ValidationError(problem ?? "enter the web address that should receive finished calls");
        next.webhook_url = url;
        if (!next.webhook_secret_sealed) { shownSecret = newSecret(); next.webhook_secret_sealed = encryptJson({ secret: shownSecret }); }
      }
    } else if (key === "rotate_webhook_secret") {
      if (value === true && next.webhook_url) { shownSecret = newSecret(); next.webhook_secret_sealed = encryptJson({ secret: shownSecret }); }
    } else {
      throw new ValidationError(`unknown setting '${String(key).slice(0, 40)}'`);
    }
  }
  await asSystem((db) => db.query("UPDATE organizations SET settings = $2 WHERE id = $1", [orgId, JSON.stringify(next)]));
  return { ...shape(next), ...(shownSecret ? { webhook_secret: shownSecret } : {}) };
}
