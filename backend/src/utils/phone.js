import { ValidationError } from "./errors.js";

/** E.164 for an Indian number given any common way ("8065520552", "+91 80655 20552"). */
export function normalizeNumber(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = "91" + digits;
  if (digits.length < 8 || digits.length > 15) {
    throw new ValidationError(`'${String(raw ?? "").slice(0, 40)}' is not a phone number`);
  }
  return "+" + digits;
}

export const CALL_ID = /^[A-Za-z0-9-]{6,64}$/;
export const AGENT_ID = /^ag_[0-9a-f]{12}$/;
