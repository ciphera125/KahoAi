// A bulk change on contacts, one at a time, that says honestly how many it did. Marking someone
// Do not call that quietly did not happen is worse than an error, so no failure is swallowed.
export async function runEach(ids, fn) {
  let failed = 0;
  let firstError = null;
  for (const id of ids) {
    try { await fn(id); } catch (e) { failed++; firstError ??= String(e?.message ?? e).slice(0, 120); }
  }
  return { done: ids.length - failed, failed, firstError };
}

const contacts = (n) => `${n} contact${n === 1 ? "" : "s"}`;

export function bulkMessage(verb, { done, failed, firstError = null }) {
  if (!failed) return { text: `${contacts(done)} ${verb}.`, bad: false };
  const why = `${failed} could not be changed${firstError ? ` (${firstError})` : ""}. Try again.`;
  return { text: done ? `${contacts(done)} ${verb}. ${why}` : `None were ${verb}. ${why}`, bad: true };
}

/** "7, 7, 7 and a last 1" for 22 people at 7 at once; long lists are shortened. */
export function groupsText(total, size) {
  const full = Math.floor(total / size), rest = total % size;
  if (full === 0) return `one group of ${rest}`;
  const head = full <= 3 ? Array(full).fill(size).join(", ") : `${size}, ${size}, ${size} … (${full} groups of ${size})`;
  return rest ? `${head} and a last ${rest}` : head;
}

/** What a run looks like to the rows below it: when this changes, the list of people must be fetched again.
 * The live view polls for the run alone (a few numbers) and fetches 5,000 rows only when this moves. */
export function countsKey(run) {
  if (!run) return "";
  const c = run.counts ?? {};
  return [run.status, run.waiting ?? "", c.queued, c.calling, c.done, c.answered, c.skipped, c.failed, c.total].join("|");
}
