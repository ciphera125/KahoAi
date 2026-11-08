// Settings that hold for the whole organization, whatever an agent says: a cap on how long any
// call can be, and the hours calls may be placed. The admin's, not the agent builder's.
import { asSystem } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { checkWindow, DEFAULT_WINDOW, MAX_MINUTES } from "./Agent.js";

const shape = (stored) => ({
  max_minutes: Number.isInteger(stored?.max_minutes) ? stored.max_minutes : null,
  call_window: { ...DEFAULT_WINDOW, ...stored?.call_window },
});

export async function get(orgId) {
  const { rows } = await asSystem((db) => db.query("SELECT settings FROM organizations WHERE id = $1", [orgId]));
  if (!rows[0]) throw new NotFoundError("organization");
  return shape(rows[0].settings);
}

export async function update(orgId, changes) {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    throw new ValidationError("settings must be an object");
  }
  const current = await get(orgId);
  const next = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (key === "max_minutes") {
      if (value === null) next.max_minutes = null;
      else if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_MINUTES) next.max_minutes = value;
      else throw new ValidationError(`The longest call must be a whole number of minutes from 1 to ${MAX_MINUTES}, or empty for no limit`);
    } else if (key === "call_window") {
      next.call_window = checkWindow(current.call_window, value);
    } else {
      throw new ValidationError(`unknown setting '${String(key).slice(0, 40)}'`);
    }
  }
  await asSystem((db) => db.query("UPDATE organizations SET settings = $2 WHERE id = $1", [orgId, JSON.stringify(next)]));
  return next;
}
