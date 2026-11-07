// Aadhaar and PAN masking for anything stored, a port of the voice service's
// masking.py (same patterns, checked against its output in tests/calls.test.js).
// Over-masking is the right way to be wrong: a masked phone number costs a
// follow-up, a stored Aadhaar is a breach. The last four characters stay.
const DEVANAGARI = /[०-९]/g;
const SEP = "[ \\-.]?";
// \p{Nd} is any script's digit, as Python's \d is.
const AADHAAR = new RegExp(`(?<![\\p{Nd}+])(?:\\p{Nd}${SEP}){11}\\p{Nd}(?!\\p{Nd})`, "gu");
const PAN = new RegExp(`(?<![A-Za-z0-9])(?:[A-Za-z]${SEP}){5}(?:\\p{Nd}${SEP}){4}[A-Za-z](?![A-Za-z0-9])`, "gu");

export function maskSensitive(text) {
  return String(text ?? "")
    .replace(DEVANAGARI, (d) => String(d.charCodeAt(0) - 0x966))
    .replace(AADHAAR, (m) => `XXXX XXXX ${m.replace(/\P{Nd}/gu, "").slice(-4)}`)
    .replace(PAN, (m) => `XXXXXX${m.replace(/[^\p{L}\p{Nd}]/gu, "").toUpperCase().slice(-4)}`);
}

/** Live captions are fragments, so a number split across them cannot be
 * recognised: every digit is blanked, as transcript.py does. */
export const blankDigits = (text) => String(text ?? "").replace(/\p{Nd}/gu, "•");

// A ten-digit Indian mobile, with or without +91. Used only for what a tool was sent
// and what it answered: the history is there to show whether a tool worked, not to be
// another copy of someone's number. The last four stay, so a wrong number is still
// recognisable as the wrong one.
const MOBILE = new RegExp(`(?<![\\p{Nd}])(?:\\+?91${SEP})?[6-9](?:${SEP}\\p{Nd}){9}(?!\\p{Nd})`, "gu");

/** maskSensitive, plus phone numbers. For tool arguments and results. */
export function maskForAudit(text) {
  return maskSensitive(text).replace(MOBILE, (m) => {
    const digits = m.replace(/\P{Nd}/gu, "");
    return `XXXXXX${digits.slice(-4)}`;
  });
}
