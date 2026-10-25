import { ValidationError } from "./errors.js";

/** Whitespace collapsed, required and length-checked, with the Studio's wording. */
export function cleanText(raw, limit, what, required = true) {
  const text = String(raw ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (required && !text) throw new ValidationError(`the ${what} is empty`);
  if (text.length > limit) throw new ValidationError(`the ${what} is over ${limit} characters`);
  return text;
}
