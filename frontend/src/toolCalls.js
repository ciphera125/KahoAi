// What the Tool calls page, a call's transcript and the live view need to say about tool calls.
// The outcome itself is decided on the server (backend/src/models/toolOutcome.js); this only shows it.

/** Green when it worked, red when it needs you, grey when it held back on purpose or was not recorded. */
const PILLS = { worked: "live", failed: "failed", not_attached: "failed", needs_info: "muted", blocked: "muted", unknown: "unknown" };
export const pillClass = (outcome) => PILLS[outcome] ?? "unknown";

/** The result filter, what needs attention first. Values are the server's `outcome` groups. */
export const RESULT_FILTERS = [
  ["", "Any result"],
  ["attention", "Needs your attention"],
  ["worked", "Worked"],
  ["held", "Held back on purpose"],
  ["unknown", "Not recorded"],
];

/** The history's request: only the filters that are set, then the page. */
export function toolCallsUrl(filters, page, size) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(filters ?? {})) if (value) q.set(key, value);
  q.set("page", String(page));
  q.set("per_page", String(size));
  return `/api/calls/tools?${q.toString()}`;
}

/** A call's transcript with its tool calls in their places, by each line's position in the call. */
export function weave(turns, tree) {
  // `pos` is set after the spread: a line's own `at` is its clock time, not its place.
  const lines = (turns ?? []).map((t) => ({ ...t, kind: "turn", pos: Number(t.seq) || 0 }));
  const tools = (tree?.turns ?? []).flatMap((g) => g.calls).map((c) => ({ ...c, kind: "tool", pos: Number(c.id) || 0 }));
  return [...lines, ...tools].sort((a, b) => a.pos - b.pos || (a.kind === "turn" ? -1 : 1));
}

// India's day, because that is where the calls are made.
const dayOf = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

/** Whether a task is overdue (due on a day that has gone), due today, due later, or has no date. */
export function dueState(task, now = new Date()) {
  if (task?.status === "done") return "done";
  if (!task?.due_at) return "none";
  const due = new Date(task.due_at);
  if (Number.isNaN(due.getTime())) return "none";
  const [a, b] = [dayOf(due), dayOf(now)];
  return a < b ? "overdue" : a === b ? "today" : "later";
}

const HOW = { needs_info: "needed more from the caller", blocked: "stopped by a safety check", failed: "did not work" };

/** One line for the live transcript: the tool in words, and how it went when that was not plain success. */
export function liveToolLine(e) {
  const label = e?.label || e?.name || "a tool";
  if (e?.outcome === "not_attached") return `Tried to use ${label}, which this agent does not have`;
  return HOW[e?.outcome] ? `${label}: ${HOW[e.outcome]}` : label;
}
