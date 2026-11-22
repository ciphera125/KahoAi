// What one tool call came to, and how to say it to the person who runs the business.
//
// Six outcomes, because "did not work" hid three very different things: a safety check doing its job
// (the agent tried to hang up before a goodbye), a tool waiting on something only the caller can give
// (a date, a name), and a real breakdown (your system did not answer). Only the last two kinds ask
// anything of the owner, so only they are "needs attention".
//
// The meaning of each message a tool sends back lives in toolReasons.json, shared with the voice
// service's tests, so a new message cannot slip in without someone deciding what it means.
import { readFileSync } from "node:fs";
import { shortWhen } from "../utils/indiaTime.js";

const { reasons: REASONS } = JSON.parse(readFileSync(new URL("./toolReasons.json", import.meta.url), "utf8"));

export const OUTCOMES = ["worked", "needs_info", "blocked", "failed", "not_attached", "unknown"];
export const OUTCOME_LABELS = {
  worked: "Worked", needs_info: "Needed more info", blocked: "Stopped by a safety check",
  failed: "Failed", not_attached: "Not switched on", unknown: "Not recorded",
};
/** How the page's filter offers them: what worked, what needs you, what held back on purpose. */
export const GROUPS = { worked: ["worked"], attention: ["failed", "not_attached"], held: ["needs_info", "blocked"], unknown: ["unknown"] };
export const needsAttention = (outcome) => GROUPS.attention.includes(outcome);

// The same rule as the voice service's transcript.tool_succeeded, which writes `ok`.
const FAILED_FLAGS = ["ok", "saved", "added", "moved", "done"];
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** False when the tool says it could not do what was asked. `what_to_do` on its own is a tool saying it
 * could not; beside `found` it is advice riding along with a lookup that ran. */
export function succeeded(result) {
  if (!isObject(result)) return true;
  if ("error" in result) return false;
  if (FAILED_FLAGS.some((flag) => result[flag] === false)) return false;
  if ("found" in result) return true;
  return !("what_to_do" in result);
}

/** {args, result} from a stored tool line, or null when the line is missing, cut short or not ours. */
export function parseToolText(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    const value = JSON.parse(text);
    return isObject(value) ? { args: value.args ?? null, result: value.result ?? null } : null;
  } catch { return null; }
}

const messageOf = (result) => (isObject(result)
  ? [result.error, result.what_to_do, result.message].find((m) => typeof m === "string" && m.trim()) ?? null
  : null);

/** The reading of a message a tool sent back, or null when there is none. */
export function matchReason(message) {
  if (typeof message !== "string" || !message.trim()) return null;
  const said = message.toLowerCase();
  return REASONS.find((r) => said.includes(r.match)) ?? null;
}

/**
 * The outcome of one stored line. `attached` is the tools the agent had on that call (from the version
 * that answered), or null when that is not known.
 */
export function classify({ event, name, ok = null, text = null, attached = null }) {
  if (event === "tool_rejected") {
    if (!name || name === "unknown") return "failed";
    if (Array.isArray(attached)) return attached.includes(name) ? "failed" : "not_attached";
    return "not_attached";
  }
  const result = parseToolText(text)?.result;
  let worked;
  if (isObject(result)) worked = succeeded(result);
  else if (typeof ok === "boolean") worked = ok;
  else return "unknown";
  if (worked) return "worked";
  return matchReason(messageOf(result))?.outcome ?? "failed";
}

// --- the words -------------------------------------------------------------------------------------

const clip = (value, n = 80) => {
  const t = String(value ?? "").split(/\s+/).filter(Boolean).join(" ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const humanize = (key) => clip(String(key ?? "").replace(/[_-]+/g, " "), 40);

const VERBS = {
  end_call: "hang up", capture_lead: "save their details", save_answer: "save the answer",
  get_tasks: "read their task list", add_task: "add the task", reschedule_task: "move the task",
  mark_task_done: "tick off the task", search_knowledge: "check your documents", look_up_contact: "look them up",
  transfer_to_human: "hand the call to your team", call_webhook: "reach your system",
};
const RANGE_WORDS = { today: "due today", yesterday: "due yesterday", this_week: "due this week", overdue: "overdue" };

function workedSummary(name, label, args, result, { taskTitles = {}, fieldLabels = {} }) {
  const a = isObject(args) ? args : {};
  const r = isObject(result) ? result : {};
  switch (name) {
    case "end_call": return "Ended the call after the goodbye.";
    case "capture_lead": {
      if (r.status === "already_saved") return "Their details were already saved earlier on this call.";
      const who = clip(a.name, 40);
      const why = clip(a.reason);
      return who ? `Saved their details: ${who}${why ? `, “${why}”` : ""}.` : "Saved their details.";
    }
    case "save_answer": {
      const field = fieldLabels[a.field_key] ?? humanize(a.field_key);
      return r.value !== undefined && r.value !== null && field ? `Saved ${field}: ${clip(r.value, 60)}.` : "Saved an answer.";
    }
    case "get_tasks": {
      const n = Number.isFinite(Number(r.count)) ? Number(r.count) : Array.isArray(r.tasks) ? r.tasks.length : 0;
      const base = `Read their task list${RANGE_WORDS[a.range] ? ` (${RANGE_WORDS[a.range]})` : ""}`;
      return n === 0 ? `${base}: nothing to do.` : `${base}: ${n} task${n === 1 ? "" : "s"}.`;
    }
    case "add_task": {
      const title = clip(a.title ?? r.title, 60);
      const when = r.due ? shortWhen(r.due) : null;
      return `Added a task${title ? `: “${title}”` : ""}${when ? `, due ${when}` : ", with no date"}.`;
    }
    case "reschedule_task": {
      const title = taskTitles[a.task_id] ? `“${clip(taskTitles[a.task_id], 60)}”` : "a task";
      const when = r.due ? shortWhen(r.due) : null;
      return when ? `Moved ${title} to ${when}.` : `Moved ${title}.`;
    }
    case "mark_task_done": return r.title ? `Ticked off “${clip(r.title, 60)}”.` : "Ticked off a task.";
    case "search_knowledge": {
      const q = clip(a.question, 60);
      if (r.found === false) return q ? `Nothing in your documents answers “${q}”.` : "Nothing in your documents answered the question.";
      return q ? `Found the answer to “${q}” in your documents.` : "Found an answer in your documents.";
    }
    case "check_availability": {
      const n = Number.isFinite(Number(r.count)) ? Number(r.count) : Array.isArray(r.slots) ? r.slots.length : 0;
      return n === 0 ? "Checked your calendar: nothing free in that window." : `Checked your calendar: ${n} free time${n === 1 ? "" : "s"} to offer.`;
    }
    case "book_meeting": return r.when ? `Booked a meeting for ${clip(r.when, 60)}.` : "Booked a meeting.";
    case "look_up_contact": return "Looked up what you already know about them.";
    case "transfer_to_human": return "Passed the call to your team.";
    case "call_webhook": return a.action ? `Asked your system: “${humanize(a.action)}”.` : "Asked your system.";
    default: return `Used “${label}”: your system answered.`;
  }
}

/**
 * {summary, why, fix} for one tool call: what happened in one line, why when it did not do the job,
 * and what the owner can do about it, only when there is something to do.
 */
export function describeCall({ event, name, label = name, outcome, args = null, result = null, taskTitles, fieldLabels }) {
  const shown = label || name || "a tool";
  if (event === "tool_rejected") {
    if (outcome === "not_attached") {
      return { summary: `Tried to use “${shown}”, which this agent does not have. It answered in words instead.`, why: null,
        fix: `If it should be able to, switch on “${shown}” for this agent under Agents, then Tools, and publish.` };
    }
    if (!name || name === "unknown") {
      return { summary: "Tried to use a tool, but the request was refused. It answered in words instead.", why: null, fix: null };
    }
    return { summary: `Tried to use “${shown}” with details that did not fit, so it was refused. It answered in words instead.`, why: null,
      fix: "Usually a one-off. If it keeps happening, make the agent's instructions about this tool clearer." };
  }
  if (outcome === "unknown") {
    return { summary: `Used “${shown}”. Whether it worked was not recorded on this older call.`, why: null, fix: null };
  }
  if (outcome === "worked") {
    const fix = name === "search_knowledge" && isObject(result) && result.found === false
      ? "If callers ask this often, add the answer to the agent's documents under Agents, then Knowledge." : null;
    return { summary: workedSummary(name, shown, args, result, { taskTitles: taskTitles ?? {}, fieldLabels: fieldLabels ?? {} }), why: null, fix };
  }
  const verb = VERBS[name] ?? `use “${shown}”`;
  const message = messageOf(result);
  const reason = matchReason(message);
  const summary = outcome === "needs_info" ? `Did not ${verb} yet: it needed more from the caller.`
    : outcome === "blocked" ? `Did not ${verb}: a safety check stopped it.`
      : `Could not ${verb}.`;
  return { summary, why: reason?.plain ?? message ?? null, fix: reason?.fix ?? null };
}
