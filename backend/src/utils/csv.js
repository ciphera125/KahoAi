// Spreadsheets: what everything filed in Storage is written as. Plain CSV that opens in Excel, Numbers and Google Sheets.
//
// A cell that starts with = + - @ (or a tab or return) is prefixed with ' so a name or message typed by a person can
// never run as a formula when the file is opened. A file opens with a byte-order mark so Hindi and accented
// text show correctly in Excel; the mark is added when a file is filed (storage.putCsv), not here.
const SAFE_START = /^[=+\-@\t\r]/;

export const cell = (value) => {
  const t = value === null || value === undefined ? "" : String(value);
  const safe = SAFE_START.test(t) ? `'${t}` : t;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export const sheet = (head, rows) => `${[head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;

/** A moment as India reads it: 2026-11-08 15:55 IST. Empty when there is none. */
export function stamp(d) {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute} IST`;
}

/** Reads CSV back into rows of cells (for tests and checks). Handles quotes, doubled quotes and line breaks inside a cell. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = ""; rows.push(row); row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
