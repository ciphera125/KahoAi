// The notification feed as the bell shows it: pages merged into one list, and day headings.
import { dayWord } from "./time.js";

const byNewest = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (a.id < b.id ? 1 : -1));

/** `more` merged into `have`: no item twice (the fresher copy wins), newest first. */
export function addPage(have, more) {
  const seen = new Map();
  for (const n of Array.isArray(have) ? have : []) seen.set(n.id, n);
  for (const n of Array.isArray(more) ? more : []) seen.set(n.id, n);
  return [...seen.values()].sort(byNewest);
}

/** Each item with `day` set where a new day begins (Today, Yesterday, 3 Nov), and null otherwise. */
export function withDays(items, now = new Date()) {
  let last = null;
  return items.map((n) => {
    const day = dayWord(n.at, now);
    const out = { ...n, day: day === last ? null : day };
    last = day;
    return out;
  });
}
