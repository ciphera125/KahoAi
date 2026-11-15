// A day typed as YYYY-MM-DD, read as a day in India (where the people reading the screens are).
import { ValidationError } from "./errors.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** On the calendar: 2026-02-31 is not a day, though Date.parse rolls it into March. */
export function isRealDay(raw) {
  const [y, m, d] = raw.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1900;
}

/** The day, or null when none was given. Anything else that is not a real day is refused. */
export function day(raw, label) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !DAY.test(raw) || !isRealDay(raw)) throw new ValidationError(`${label} must be a day like 2026-11-14`);
  return raw;
}

/** The first and last instants of an India day. */
export const startOfDay = (d) => new Date(`${d}T00:00:00+05:30`);
export const endOfDay = (d) => new Date(`${d}T23:59:59.999+05:30`);
