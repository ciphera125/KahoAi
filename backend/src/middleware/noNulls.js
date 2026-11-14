// A NUL byte (\u0000) cannot be stored in PostgreSQL text, so one in a search, a filter or a saved
// field was a 500 on every endpoint that took text. Refuse it up front with a plain 400.
import { ValidationError } from "../utils/errors.js";

function has(value, depth = 0) {
  if (typeof value === "string") return value.includes("\u0000");
  if (depth > 20 || value === null || typeof value !== "object") return false;
  for (const key of Object.keys(value)) if (key.includes("\u0000") || has(value[key], depth + 1)) return true;
  return false;
}

/** Strip NULs from every string, in place: for the voice service, whose lines must be saved, not refused. */
function strip(value, depth = 0) {
  if (typeof value === "string") return value.replaceAll("\u0000", "");
  if (depth > 20 || value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) value[key] = strip(value[key], depth + 1);
  return value;
}

export function refuseNulls(req, _res, next) {
  if (has(req.query) || has(req.body) || has(req.params)) {
    return next(new ValidationError("text cannot contain a null character"));
  }
  next();
}

export function stripNulls(req, _res, next) {
  if (req.body) req.body = strip(req.body);
  next();
}
