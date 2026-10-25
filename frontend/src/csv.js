// Reading a call list (CSV from Excel, Google Sheets or by hand) into
// [{ name, number }]. The numbers are checked by the server, which says why a
// row is skipped; this only finds the columns and splits the cells.

const NAME = /^(full\s*)?name$|^(customer|contact|person)(\s*name)?$/i;
const NUMBER = /phone|mobile|number|contact\s*no|^mob$|^tel/i;
const LOOKS_LIKE_NUMBER = /^[+\d][\d\s\-()]{6,}$/;

function separator(firstLine) {
  const counts = [",", ";", "\t"].map((s) => [s, firstLine.split(s).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/** Rows of cells, honouring quotes ("a, b" and "" inside them). */
function cells(text, sep) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell.trim() === "") { quoted = true; cell = ""; }
    else if (c === sep) { row.push(cell.trim()); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim()); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  row.push(cell.trim());
  rows.push(row);
  return rows.filter((r) => r.some((x) => x !== ""));
}

export function parseCallList(text) {
  const clean = String(text ?? "").replace(/^\uFEFF/, "");
  if (!clean.trim()) throw new Error("The file is empty.");
  const sep = separator(clean.split(/\r?\n/).find((l) => l.trim()) || "");
  const all = cells(clean, sep);
  const first = all[0];
  let nameCol = first.findIndex((c) => NAME.test(c));
  let numberCol = first.findIndex((c) => NUMBER.test(c) && !LOOKS_LIKE_NUMBER.test(c));
  const header = numberCol !== -1 || (nameCol !== -1 && !first.some((c) => LOOKS_LIKE_NUMBER.test(c)));
  const body = header ? all.slice(1) : all;
  if (numberCol === -1) {
    // No header naming it: the column whose cells look like numbers.
    const width = Math.max(...body.map((r) => r.length));
    let best = -1, bestScore = 0;
    for (let col = 0; col < width; col++) {
      const score = body.filter((r) => LOOKS_LIKE_NUMBER.test(r[col] ?? "")).length;
      if (score > bestScore) { best = col; bestScore = score; }
    }
    if (best === -1) throw new Error("Could not find a phone number column. Name one column “phone” or “number”.");
    numberCol = best;
  }
  if (nameCol === -1 || nameCol === numberCol) {
    nameCol = header ? first.findIndex((c, i) => i !== numberCol && /name/i.test(c)) : -1;
    if (nameCol === -1) {
      const width = Math.max(...body.map((r) => r.length));
      nameCol = width > 1 ? [...Array(width).keys()].find((i) => i !== numberCol) : -1;
    }
  }
  return {
    header,
    rows: body.map((r) => ({ name: nameCol >= 0 ? r[nameCol] ?? "" : "", number: r[numberCol] ?? "" })),
  };
}
