// What the Publish button at the top of an agent says and does (owner, 2026-11-22: a client edits, and must
// see at once that the edit is not live yet, and have one clear button to make it live).

/** "published": nothing to do. "ready": the draft passes every check, one press publishes it.
 * "review": it has a problem or has not been tested yet, so the press goes to the checks below. */
export function publishState(agent, check) {
  const draft = Boolean(agent?.draft_changed);
  if (!draft) return { mode: "published", draft: false, blocked: false, untested: false, reasons: 0 };
  const problems = Array.isArray(check?.problems) ? check.problems : [];
  const untested = Boolean(check?.test_required) && check?.test?.status !== "passed";
  const blocked = problems.length > 0 || untested;
  return { mode: blocked ? "review" : "ready", draft: true, blocked, untested, reasons: problems.length + (untested && !problems.length ? 1 : 0) };
}
