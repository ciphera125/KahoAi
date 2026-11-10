// What is kept out of files that sit in Storage in plain text (transcripts, call records, what was
// asked of Kaho Builder): e-mail addresses, phone numbers and any other long run of digits, a PAN,
// and the names of the people in the call. Aadhaar and PAN were already masked when the call was
// written down; this is the second net, for what the first one cannot know (a phone number said
// aloud, an e-mail address, the contact's own name). It cannot find a name nobody told it about.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PAN = /\b(?!X{5})[A-Z]{5}[0-9]{4}[A-Z]\b/g; // not one already masked as XXXXX1234X
// 9 or more digits, allowing spaces, dots, dashes and brackets between them: a phone, a card, an account.
const LONG_NUMBER = /\+?\d(?:[\s().-]?\d){8,}/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const MIN_NAME = 3;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactPII(text, { names = [] } = {}) {
  let out = String(text ?? "");
  if (!out) return "";
  const dates = [];
  out = out.replace(ISO_DATE, (d) => { dates.push(d); return `\uE000${dates.length - 1}\uE001`; }); // a date is not a number to hide
  out = out.replace(EMAIL, "[email]").replace(PAN, "[PAN]").replace(LONG_NUMBER, "[number]");
  const parts = [...new Set(names.flatMap((n) => String(n ?? "").split(/\s+/))
    .filter((n) => n.length >= MIN_NAME))].sort((a, b) => b.length - a.length);
  for (const part of parts) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(part)}(?![\\p{L}\\p{N}])`, "giu"), "[name]");
  return out.replace(/\uE000(\d+)\uE001/g, (_m, i) => dates[Number(i)]);
}
