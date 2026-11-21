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
export function todayIn(now, timezone = TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

export const isoDay = ({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
export const asDay = (parts) => asDate(parts);

/** Day arithmetic done at noon UTC, far from any midnight a time zone could cross. */
const asDate = ({ y, m, d }) => new Date(Date.UTC(y, m - 1, d, 12));
const fromDate = (date) => ({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() });
const addDays = (parts, n) => fromDate(new Date(asDate(parts).getTime() + n * 86400000));
const isReal = ({ y, m, d }) => { const t = asDate({ y, m, d }); return t.getUTCMonth() + 1 === m && t.getUTCDate() === d; };

// Words that only frame a day ("on Friday", "by tomorrow", "this coming Monday"). "next" is not one of
// them: it moves a weekday a week on.
const FRAMING = /^(?:(?:by|on|for|till|until|before|this|coming|upcoming)\s+)+/;
const MAX_DAYS_AHEAD = 366;

function parseDate(said, now, timezone) {
  const text = said.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  const core = text.replace(FRAMING, "");
  const today = todayIn(now, timezone);

  if (/^(today|aaj)\b/.test(core)) return accept(isoDay(today));
  if (/^(day after tomorrow|parso|parson)\b/.test(core)) return accept(isoDay(addDays(today, 2)));
  if (/^(tomorrow|kal)\b/.test(core)) return accept(isoDay(addDays(today, 1)));

  // "in 3 days", "after 2 days", "10 din baad": counted from today.
  const ahead = core.match(/^(?:in|after)\s+(\d{1,4})\s+days?\b/) ?? core.match(/^(\d{1,4})\s+(?:din|days?)\s+(?:baad|bad|later|mein|me|from now)\b/);
  if (ahead) {
    const n = Number(ahead[1]);
    if (n < 1 || n > MAX_DAYS_AHEAD) return refuse("I did not catch the date. Please ask for the exact date, like the fifteenth of December.");
    return accept(isoDay(addDays(today, n)));
  }

  // An exact date first, so "Tuesday 15 December" is the 15th whatever day the weekday names.
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

  // A weekday, with or without "next": the next one that has not gone. The same weekday
  // as today means a week away, because nobody says "Monday" on Monday meaning today.
  const weekday = core.match(/^(next|agle|agla|agli)?\s*([a-z]+)\b/);
  if (weekday && DAYS[weekday[2]] !== undefined) {
    const want = DAYS[weekday[2]];
    let gap = (want - asDate(today).getUTCDay() + 7) % 7;
    if (gap === 0) gap = 7;
    if (weekday[1] && gap < 7) gap += 7;
    return accept(isoDay(addDays(today, gap)));
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
  return accept(isoDay(parts));
}

// --- when a task is due: a day, and the time of day when one was said ----------
//
// A reminder at the wrong hour is a reminder nobody gets, so a bare hour ("at 5", "6 baje") is not
// guessed at: the agent is asked to check morning or evening. A part of the day said without an
// hour ("tomorrow evening") takes the usual hour for it.

const PERIOD_WORDS = {
  morning: ["subah", "savere", "sawere", "morning"],
  afternoon: ["dopahar", "dopehar", "dupahar", "afternoon"],
  evening: ["shaam", "sham", "evening"],
  night: ["raat", "night"],
};
const PERIOD_RE = new RegExp(`\\b(${Object.values(PERIOD_WORDS).flat().join("|")})\\b`);
const PERIOD_OF = Object.fromEntries(Object.entries(PERIOD_WORDS).flatMap(([p, words]) => words.map((w) => [w, p])));
const USUAL_HOUR = { morning: 9, afternoon: 14, evening: 18, night: 20 };
const P = Object.values(PERIOD_WORDS).flat().join("|");
const TIME_PATTERNS = [
  // 5 pm, 10:30 am, 6.45 p.m.
  { re: /(?:\b(?:at|@)\s*)?\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/, meridiem: 3 },
  // shaam 6, morning 8:30
  { re: new RegExp(`\\b(?:${P})\\s+(?:at\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s*(?:baje|bje|o'?\\s?clock))?(?![\\w/-])`) },
  // 7 in the evening, 6 baje shaam
  { re: new RegExp(`\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*(?:baje|bje|o'?\\s?clock)?\\s+(?:in the\\s+)?(?:${P})\\b`) },
  // 6 baje, 5 o'clock
  { re: /(?:\b(?:at|@)\s*)?\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:baje|bje|o'?\s?clock)\b/ },
  // 17:30, at 9:15
  { re: /(?:\b(?:at|@)\s*)?\b(\d{1,2}):(\d{2})\b/ },
  // at 5 (and not "at 15 December", "at the 5th")
  { re: /\b(?:at|@)\s*(\d{1,2})\b(?!\s*(?:st|nd|rd|th|tarikh|tareekh|days?|din|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b)(?![/-])/ },
];

/** The time of day in what was said: {found, hour, minute} with `rest` the words left for the day, or
 * {ambiguous} for a bare hour, or {invalid} for an hour that does not exist. */
function readTime(text) {
  const periodWord = text.match(PERIOD_RE)?.[1] ?? null;
  const period = periodWord ? PERIOD_OF[periodWord] : null;
  const withoutPeriod = (s) => (periodWord ? s.replace(new RegExp(`\\b${periodWord}\\b`), " ") : s);
  for (const { re, meridiem } of TIME_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const raw = m[1];
    const h = Number(raw);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    if (minute > 59) return { invalid: true };
    const rest = withoutPeriod(text.replace(m[0], " "));
    if (meridiem) {
      if (h < 1 || h > 12) return { invalid: true };
      const pm = m[meridiem].startsWith("p");
      return { found: true, hour: pm ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h), minute, rest };
    }
    if (h > 23) return { invalid: true };
    if (h >= 13 || h === 0 || (raw.length === 2 && raw.startsWith("0"))) return { found: true, hour: h, minute, rest };
    const hour = !period ? null
      : period === "morning" ? (h === 12 ? null : h)
        : period === "afternoon" ? (h === 12 ? 12 : h <= 6 ? h + 12 : h)
          : period === "evening" ? (h === 12 ? null : h + 12)
            : (h >= 6 && h <= 11 ? h + 12 : null);
    if (hour === null) return { ambiguous: true };
    return { found: true, hour, minute, rest };
  }
  if (period) return { found: true, hour: USUAL_HOUR[period], minute: 0, rest: withoutPeriod(text) };
  return { found: false, rest: text };
}

const pad2 = (n) => String(n).padStart(2, "0");

/** When a task is due, as an instant: the day the caller said, at the time they said or 9 in the
 * morning. Refused, with a line the agent can say, when either is not certain. */
export function parseTaskDue(said, { now = new Date(), timezone = TZ } = {}) {
  const text = String(said ?? "").toLowerCase().replace(/\btonight\b/g, "today night").replace(/\s+/g, " ").trim();
  if (!text) return refuse("I did not catch the date. Please ask for the exact date, like the fifteenth of December.");
  const time = readTime(text);
  if (time.invalid) return refuse("I did not catch the time. Please ask for it again, like 5 in the evening.");
  if (time.ambiguous) return refuse("That time could be in the morning or the evening. Please ask which they mean.");
  const rest = time.rest.replace(/\b(?:ko|ke|at)\b|@/g, " ").replace(/\s+/g, " ").trim();
  const day = rest ? parseDate(rest, now, timezone) : accept(isoDay(todayIn(now, timezone)));
  if (!day.ok) return day;
  const value = new Date(`${day.value}T${pad2(time.found ? time.hour : 9)}:${pad2(time.found ? time.minute : 0)}:00+05:30`);
  if (time.found && value <= now) return refuse("That time today has already gone. Please ask for a later time.");
  return { ok: true, value, day: day.value, time_said: Boolean(time.found), message: null };
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
