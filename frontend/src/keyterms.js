// The words an agent listens for, as a person types them: one to a line. The server is the judge of what
// is allowed (no commas, a length, a total); this only turns the box into a list and back, tidily.

export const KEYTERM_LIMIT = 50; // the server's own limit, shown as a count next to the box

/** One word or name per line; spaces, blank lines and repeats (any capitals) are dropped. */
export function parseKeyterms(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const term = line.trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

export const keytermsText = (list) => (Array.isArray(list) ? list : []).join("\n");
