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
