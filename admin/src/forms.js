// What an admin types into a terms form, and what the server takes. Money is typed in rupees and sent as whole
// paise; it is parsed as text, digit by digit, never as a floating-point number (19.99 * 100 is not 1999 there).
// Anything that is not exactly an amount is refused rather than rounded: a guess here prices a customer wrongly.

/** [term, label, kind]: the order is the rate card's. */
export const TERM_FIELDS = [
  ["price_paise", "Price per month (₹)", "money"],
  ["minutes_included", "Minutes included", "int"],
  ["approx_calls", "About how many calls", "int"],
  ["rate_paise", "Works out to (₹ per minute)", "money"],
  ["extra_paise", "Extra minutes (₹ per minute)", "money"],
  ["simultaneous", "Simultaneous calls", "int"],
  ["log_days", "Call logs kept (days)", "int"],
  ["support", "Support", "text"],
  ["languages", "Languages", "text"],
];

// Digits, optionally grouped with commas the Indian or the Western way (1,23,456 or 123,456), then at most two decimals.
const GROUPED = String.raw`(?:\d{1,3}(?:,\d{2,3})+|\d+)`;
const MONEY = new RegExp(`^(${GROUPED})(?:\\.(\\d{1,2}))?$`);
const WHOLE = new RegExp(`^${GROUPED}$`);

/** The box's text as the value the server takes, or an Error saying what is wrong. `empty: true` lets an empty box mean "no value". */
export function fromInput(kind, text, { empty = false } = {}) {
  const raw = String(text ?? "").trim();
  if (kind === "text") return raw === "" ? null : raw;
  if (raw === "") {
    if (empty) return null;
    throw new Error(kind === "money" ? "Type an amount in rupees." : "Type a whole number.");
  }
  if (kind === "int") {
    if (!WHOLE.test(raw)) throw new Error("This must be a whole number.");
    return Number(raw.replaceAll(",", ""));
  }
  const m = MONEY.exec(raw);
  if (!m) throw new Error("Type an amount in rupees, like 4.5 or 5499 (at most two decimals).");
  return Number(m[1].replaceAll(",", "")) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
}

/** A stored value as the box shows it. */
export function toInput(kind, value) {
  if (value === null || value === undefined) return "";
  if (kind === "money") {
    const rupees = Math.trunc(value / 100);
    const paise = value % 100;
    return paise === 0 ? String(rupees) : `${rupees}.${String(paise).padStart(2, "0").replace(/0$/, "")}`;
  }
  return String(value);
}

/** Only the terms whose box differs from what is stored, in server units. An untouched or empty box is left out. */
export function changed(typed, before) {
  const out = {};
  for (const [key, , kind] of TERM_FIELDS) {
    if (typed[key] === undefined) continue;
    const value = fromInput(kind, typed[key], { empty: true });
    if (value === null) continue;
    if (value !== before[key]) out[key] = value;
  }
  return out;
}
