// What is kept out of files that sit in Storage in plain text (transcripts, call records, what was
// asked of Kaho Builder): e-mail addresses (written or spoken), UPI ids, phone numbers and any other
// long run of digits (written, spoken as words, in any Indian script, or said across several turns),
// a PAN, a date of birth, and names (the contact's own, even misspelt, and one a caller gives for
// themselves). Aadhaar and PAN were already masked when the call was written down; this is the second
// net, for what the first one cannot know. It still cannot find a name that nobody told it about and
// that was not introduced as one; the person who runs the platform should know that.
//
// Each rule may over-redact (a word that looks like a name, a number that was not private): that is
// the safe direction. Running it twice gives the same text.

// The digit zero of each script we meet on calls, so a number written in Devanagari, Bengali, Tamil...
// or full-width is read as the number it is.
const ZEROS = [0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xff10];
function fold(text) {
  return text.replace(/＠/g, "@").replace(/．/g, ".")
    .replace(/[٠-٩۰-۹०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯０-９]/g,
      (c) => { const cp = c.codePointAt(0); return String(cp - ZEROS.filter((z) => z <= cp).pop()); });
}

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const UPI = /(?<![A-Za-z0-9._-])[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9]+/g; // name@bank: no dot, but still an address
const PROVIDERS = "gmail|googlemail|yahoo|ymail|hotmail|outlook|live|rediff|rediffmail|icloud|proton|protonmail|aol";
const TLD = "com|in|co|org|net|edu|gov|io|me";
// "ravi dot kumar at gmail dot com", "ravi at the rate gmail dot com". A common provider, or "at the rate",
// is required so that "look at the dot com boom" stays as it is.
const SPOKEN_LOCAL = String.raw`[A-Za-z0-9_]+(?:\s+(?:dot|underscore|dash)\s+[A-Za-z0-9_]+){0,4}`;
const SPOKEN_EMAIL = new RegExp(String.raw`\b${SPOKEN_LOCAL}\s+(?:at\s+the\s+rate(?:\s+of)?\s+[A-Za-z0-9-]+|at\s+(?:${PROVIDERS}))(?:\s+dot\s+[A-Za-z0-9-]+){0,3}?\s+dot\s+(?:${TLD})(?:\s+dot\s+(?:${TLD}))?\b`, "gi");

const PAN = /\b(?!X{5})[A-Z]{5}[0-9]{4}[A-Z]\b/g; // not one already masked as XXXXX1234X

// A turn's label in a written transcript: "[10:25:20 am] Caller:". Digits inside it are not the caller's.
const LABEL = String.raw`\[[^\]\n]*\]\s*(?:Caller|Agent|User):?`;
const LABEL_SPLIT = new RegExp(`(${LABEL})`);
// Nine or more digits, with spaces, dots, dashes or brackets between them, or across the turns of a call
// where nobody else spoke in between: a phone, a card, an account.
const LONG_NUMBER = new RegExp(String.raw`\+?\d(?:(?:[\s().-]|${LABEL})*\d){8,}`, "g");
const DIGIT_GROUP = /\+?\d+(?:[\s().-]+\d+)*/g;

const DIGIT_WORDS = ["zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "shunya", "ek", "do", "teen", "char", "chaar", "paanch", "panch", "chhe", "chhah", "cheh", "saat", "aath", "nau",
  "double", "triple", "dabal", "tripal", "डबल", "ट्रिपल", "शून्य", "एक", "दो", "तीन", "चार", "पांच", "पाँच", "छह", "छः", "सात", "आठ", "नौ"].join("|");
const WORD = String.raw`(?:${DIGIT_WORDS})(?![\p{L}\p{M}])`;
// A chain of digit groups and digit words (in any mix), joined by spaces, dots, dashes or brackets only
// (not commas, so 1,00,00,000 is an amount). Counts as a number from nine digits or words on.
const CHAIN = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}])\+?(?:\d+|${WORD})(?:[\s().-]+(?:\d+|${WORD}))*`, "giu");
const units = (chain) => chain.split(/[\s().+-]+/).filter(Boolean).reduce((n, t) => n + (/^\d+$/.test(t) ? t.length : 1), 0);

// Dates of birth: a full date, in any common form, from at least five years ago. A due date, a call
// date and "5 December" are not private and stay.
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
const OLD_ENOUGH = (y) => y >= 1900 && y <= new Date().getFullYear() - 5;
const DATES = [
  /\b(\d{4})-\d{2}-\d{2}\b/g, /\b\d{1,2}[/.-]\d{1,2}[/.-](\d{4})\b/g,
  new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH},?\s+(\d{4})\b`, "gi"),
  new RegExp(String.raw`\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(\d{4})\b`, "gi"),
];
const BORN_IN = /\b(born\s+in\s+)(\d{4})\b/gi;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

const MIN_NAME = 3;
const FUZZY_FROM = 4;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One letter wrong, or two neighbouring letters swapped, and the same length. */
function nearly(word, name) {
  if (word.length !== name.length) return false;
  let diffs = 0;
  let first = -1;
  for (let i = 0; i < word.length; i++) if (word[i] !== name[i]) { if (diffs++ === 0) first = i; }
  if (diffs <= 1) return true;
  return diffs === 2 && word[first] === name[first + 1] && word[first + 1] === name[first] && word.slice(first + 2) === name.slice(first + 2);
}

const CAP_NAME = String.raw`\p{Lu}[\p{L}\p{M}'.-]*(?:\s+\p{Lu}[\p{L}\p{M}'.-]*){0,2}`;
const SELF_INTRO = new RegExp(String.raw`((?:[Mm]y name is|[Tt]his is|[Ii] am|[Ii]'m|[Mm]yself|[Nn]ame's)\s+)(${CAP_NAME})`, "gu");
const AGENT_LINE = /^\[[^\]\n]*\]\s*Agent:/;
const SELF_INTRO_HI = /(मेरा नाम\s+)((?:(?!है(?:\s|$))[^\s.,।?!]+)(?:\s+(?!है(?:\s|$))[^\s.,।?!]+)?)/g;

export function redactPII(text, { names = [], selfIntro = true } = {}) {
  let out = String(text ?? "");
  if (!out) return "";
  out = fold(out);

  for (const re of DATES) out = out.replace(re, (m, y) => (OLD_ENOUGH(Number(y)) ? "[date]" : m)); // the year is always group 1
  out = out.replace(BORN_IN, (m, lead, y) => (OLD_ENOUGH(Number(y)) ? `${lead}[date]` : m));
  const dates = [];
  out = out.replace(ISO_DATE, (d) => { dates.push(d); return `${dates.length - 1}`; }); // a recent date is not a number to hide

  out = out.replace(SPOKEN_EMAIL, "[email]").replace(EMAIL, "[email]").replace(UPI, "[email]");
  out = out.replace(PAN, "[PAN]");
  out = out.replace(/\+?\d{9,}/g, "[number]"); // a plain long run, cheaply, before anything that has to look around it
  out = out.replace(CHAIN, (m) => (units(m) >= 9 ? "[number]" : m));
  out = out.replace(LONG_NUMBER, (span) => span.split(LABEL_SPLIT).map((part, i) => (i % 2 ? part : part.replace(DIGIT_GROUP, "[number]"))).join(""));

  const parts = [...new Set(names.flatMap((n) => String(n ?? "").split(/\s+/)).filter((n) => n.length >= MIN_NAME))].sort((a, b) => b.length - a.length);
  for (const part of parts) out = out.replace(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escape(part)}(?![\\p{L}\\p{M}\\p{N}])`, "giu"), "[name]");
  const fuzzy = parts.filter((p) => p.length >= FUZZY_FROM).map((p) => p.toLowerCase());
  if (fuzzy.length) out = out.replace(/[\p{L}\p{M}]+/gu, (w) => (w.length >= FUZZY_FROM && fuzzy.some((n) => nearly(w.toLowerCase(), n)) ? "[name]" : w));
  // What the AGENT says about itself ("this is Ria") is not private; what a caller says about themselves is.
  if (selfIntro) {
    out = out.split("\n").map((line) => (AGENT_LINE.test(line) ? line : line.replace(SELF_INTRO, "$1[name]").replace(SELF_INTRO_HI, "$1[name]"))).join("\n");
  }

  return out.replace(/(\d+)/g, (_m, i) => dates[Number(i)]);
}
