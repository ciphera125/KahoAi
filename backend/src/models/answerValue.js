// Turning what a caller said into something worth storing.
//
// The agent hears speech, so an answer arrives as words: "next Friday", "2 lakh",
// "haan ji". Normalising that is done here, on the server, and never left to the model:
// the model is good at hearing and bad at being sure, and a wrong payment date is the
// kind of mistake nobody notices until it matters. Anything this cannot be certain of is
// refused with a line the agent can say, so the caller is asked again.
//
// Everything is read in India's time zone. The caller is in India and says "tomorrow"
// meaning their tomorrow, which is a different day from UTC's for five and a half hours.

export const KINDS = ["text", "number", "date", "yes_no", "choice", "phone", "amount"];
export const KIND_LABELS = {
  text: "Anything they say", number: "A number", date: "A date", yes_no: "Yes or no",
  choice: "One of a list", phone: "A phone number", amount: "An amount in rupees",
};

const TZ = "Asia/Kolkata";
const MAX_TEXT = 500;
const refuse = (message) => ({ ok: false, value: null, message });
const accept = (value) => ({ ok: true, value: String(value), message: null });

/** The kinds a mishearing is expensive on: the agent reads these back and waits for a
 * yes before they are saved. */
export const needsConfirming = (kind) => ["date", "amount", "phone"].includes(kind);

// --- dates -------------------------------------------------------------------

const DAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  ravivar: 0, somvar: 1, mangalvar: 2, budhvar: 3, guruvar: 4, shukravar: 5, shanivar: 6,
  somwar: 1, mangalwar: 2, budhwar: 3, guruwar: 4, shukrawar: 5, shaniwar: 6,
};
const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];

/** Today where the caller is, as {y, m, d}. */
function todayIn(now, timezone = TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

const iso = ({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** Day arithmetic done at noon UTC, far from any midnight a time zone could cross. */
const asDate = ({ y, m, d }) => new Date(Date.UTC(y, m - 1, d, 12));
const fromDate = (date) => ({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() });
const addDays = (parts, n) => fromDate(new Date(asDate(parts).getTime() + n * 86400000));
const isReal = ({ y, m, d }) => { const t = asDate({ y, m, d }); return t.getUTCMonth() + 1 === m && t.getUTCDate() === d; };

function parseDate(said, now, timezone) {
  const text = said.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  const today = todayIn(now, timezone);

  if (/^(today|aaj)\b/.test(text)) return accept(iso(today));
  if (/^(day after tomorrow|parso|parson)\b/.test(text)) return accept(iso(addDays(today, 2)));
  if (/^(tomorrow|kal)\b/.test(text)) return accept(iso(addDays(today, 1)));

  // A weekday, with or without "next": the next one that has not gone. The same weekday
  // as today means a week away, because nobody says "Monday" on Monday meaning today.
  const weekday = text.match(/\b(next|agle|agla)?\s*([a-z]+)\b/);
  if (weekday && DAYS[weekday[2]] !== undefined) {
    const want = DAYS[weekday[2]];
    let ahead = (want - asDate(today).getUTCDay() + 7) % 7;
    if (ahead === 0) ahead = 7;
    if (weekday[1] && ahead < 7) ahead += 7;
    return accept(iso(addDays(today, ahead)));
  }

  // 2026-12-15
  const ymd = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (ymd) return checked({ y: +ymd[1], m: +ymd[2], d: +ymd[3] }, today);

  // 15/12/2026 and 15-12-26, day first, as India writes them
  const dmy = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (dmy) {
    const year = dmy[3] ? (dmy[3].length === 2 ? 2000 + +dmy[3] : +dmy[3]) : today.y;
    return checked({ y: year, m: +dmy[2], d: +dmy[1] }, today);
  }

  // 15 December 2026, December 15
  const named = MONTHS.findIndex((m) => text.includes(m.slice(0, 3)) && /[a-z]{3}/.test(text));
  if (named >= 0) {
    const day = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
    const year = text.match(/\b(20\d{2})\b/);
    if (day) {
      const guess = { y: year ? +year[1] : today.y, m: named + 1, d: +day[1] };
      // No year said and that date has gone: they mean next year.
      if (!year && asDate(guess) < asDate(today)) guess.y += 1;
      return checked(guess, today);
    }
  }

  // "the 15th", "5 tarikh": this month, or next if it has gone.
  const dayOnly = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b\s*(tarikh|tareekh)?/);
  if (dayOnly && (dayOnly[2] || /\b(the|on)\b/.test(text) || /^\d{1,2}(st|nd|rd|th)$/.test(text.trim()))) {
    const day = +dayOnly[1];
    let guess = { y: today.y, m: today.m, d: day };
    if (!isReal(guess) || asDate(guess) < asDate(today)) {
      guess = { y: today.m === 12 ? today.y + 1 : today.y, m: today.m === 12 ? 1 : today.m + 1, d: day };
    }
    return checked(guess, today);
  }

  return refuse("I did not catch the date. Please ask for the exact date, like the fifteenth of December.");
}

function checked(parts, today) {
  if (!isReal(parts)) return refuse("That date does not exist. Please ask for the exact date again.");
  if (asDate(parts) < asDate(today)) {
    return refuse("That date is in the past. Please check the date with the caller and ask again.");
  }
  return accept(iso(parts));
}

// --- the rest ----------------------------------------------------------------

const YES = /^(yes|yeah|yep|yup|sure|correct|right|ok|okay|haan|han|ha|haan ji|ha ji|ji|ji haan|theek hai|thik hai|bilkul|sahi)\b/;
const NO = /^(no|nope|nah|not|never|nahi|nahin|na|bilkul nahi)\b/;

const MULTIPLIERS = [
  [/\b(crore|karod|cr)\b/, 10000000], [/\b(lakh|lac|lakhs)\b/, 100000],
  [/\b(hazaar|hazar|thousand|k)\b/, 1000],
];

function parseAmount(said) {
  const text = said.toLowerCase().replace(/[₹,]/g, "").replace(/\brs\.?\b|\brupees?\b|\brupaye\b/g, " ").trim();
  const number = text.match(/-?\d+(?:\.\d+)?/);
  if (!number) return refuse("I did not catch the amount. Please ask for it again in rupees.");
  let value = Number(number[0]);
  for (const [pattern, times] of MULTIPLIERS) if (pattern.test(text)) { value *= times; break; }
  if (!Number.isFinite(value) || value < 0) return refuse("That is not an amount I can save. Please ask for it again in rupees.");
  return accept(String(Math.round(value * 100) / 100));
}

/**
 * `kind` says how to read it; `choices` is needed for a choice field. `now` is the moment
 * the call is happening, so "tomorrow" means the caller's tomorrow.
 */
export function parseAnswer(kind, said, { now = new Date(), choices = [], timezone = TZ } = {}) {
  const text = String(said ?? "").trim();
  if (!text) return refuse("I did not hear an answer. Please ask again.");

  switch (kind) {
    case "text":
      return accept(text.slice(0, MAX_TEXT));
    case "number": {
      const match = text.match(/-?\d+(?:\.\d+)?/);
      if (!match || !/^[^a-zA-Z]*-?\d/.test(text)) return refuse("I need that as a number. Please ask for the number again.");
      return accept(String(Number(match[0])));
    }
    case "amount":
      return parseAmount(text);
    case "date":
      return parseDate(text, now, timezone);
    case "yes_no": {
      const lower = text.toLowerCase();
      if (YES.test(lower)) return accept("yes");
      if (NO.test(lower)) return accept("no");
      return refuse("I could not tell whether that was a yes or a no. Please ask again.");
    }
    case "phone": {
      const digits = text.replace(/\D/g, "").replace(/^0+/, "");
      const ten = digits.length > 10 && digits.startsWith("91") ? digits.slice(2) : digits;
      if (!/^[6-9]\d{9}$/.test(ten)) return refuse("That is not a ten-digit mobile number. Please ask for it again, digit by digit.");
      return accept(`+91${ten}`);
    }
    case "choice": {
      const want = text.toLowerCase().replace(/\s+/g, " ").trim();
      const hit = choices.find((c) => String(c).toLowerCase().replace(/\s+/g, " ").trim() === want);
      if (hit) return accept(hit);
      return refuse(`That is not one of the options. Please ask them to choose one of: ${choices.join(", ")}.`);
    }
    default:
      return refuse("I cannot save that kind of answer.");
  }
}
