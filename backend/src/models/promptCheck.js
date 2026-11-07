// What a prompt may ask of an agent.
//
// 2026-11-07, call db32d982: an agent's prompt told the model to use get_tasks,
// mark_task_done, reschedule_task and add_task. None of them was attached, so the
// model's tool call was refused by Groq (400 tool_use_failed), the retry was refused
// the same way, and the caller heard an apology. A prompt is data typed by a person,
// so this is checked where it is saved, before it can ever reach a call.
import { labelOf } from "./toolCatalog.js";

// A name with an underscore inside it: get_tasks, mark_task_done. Ordinary speech and
// Hindi have none, so this is a near-certain sign of something machine-shaped.
const SNAKE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;
// {{user_name}}, {{ answer.payment_date }}
const VARIABLE = /\{\{\s*([^{}]{1,80}?)\s*\}\}/g;
// Words that turn a name into an instruction: "use get_tasks", "call mark_task_done".
const CUE = /\b(?:use|uses|used|using|call|calls|called|calling|invoke|invokes|run|runs|trigger|triggers|via|with|through)\s+$/i;

const unique = (list) => [...new Set(list)];

/** Names the prompt tells the agent to use as a tool: written as a call, `get_tasks(...)`,
 * or introduced by a cue word, "call get_tasks". A bare word in prose is left alone, so
 * parameter names inside a call's brackets are not mistaken for tools. */
function toolsNamedIn(text) {
  const found = [];
  for (const match of text.matchAll(SNAKE)) {
    const after = text.slice(match.index + match[0].length);
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (/^\s*\(/.test(after) || CUE.test(before)) found.push(match[0]);
  }
  return unique(found);
}

/** Every reason this prompt cannot be used by an agent with these tools, in plain
 * language, each naming what to do about it. An empty list means it is fine.
 * `knownVariables` are the {{...}} this agent can actually fill in: the questions it
 * saves ("answer.payment_date") and, later, the contact's own details. */
export function promptProblems(text, attachedTools = [], knownVariables = []) {
  const attached = new Set(attachedTools);
  const known = new Set(knownVariables);
  const problems = [];

  const variables = [];
  const prose = String(text ?? "").replace(VARIABLE, (_, name) => {
    variables.push(name);
    return " ";
  });

  for (const name of toolsNamedIn(prose)) {
    if (attached.has(name)) continue;
    const label = labelOf(name);
    problems.push({
      code: "unattached_tool",
      found: name,
      message: label
        ? `Your prompt tells the agent to use '${name}' (${label}), which is not one of this agent's tools. `
          + `Either attach ${label} to this agent, or take it out of the prompt.`
        : `Your prompt tells the agent to use '${name}', which is not one of this agent's tools, `
          + `and there is no such tool in Kaho AI. Take it out of the prompt, or attach a tool that does this.`,
    });
  }

  for (const name of unique(variables)) {
    // detail.* is whatever the customer's own system sends about a contact: we cannot
    // list them in advance, and an empty one is filled in as nothing rather than read out.
    if (known.has(name) || name.startsWith("detail.")) continue;
    problems.push({
      code: "unfilled_variable",
      found: name,
      message: `Your prompt uses {{${name}}}, and nothing fills it in, so the agent would read it out as it stands. `
        + `Replace it with the words you want said.`,
    });
  }
  return problems;
}

/** The first problem, as one line, or null. */
export const firstProblem = (text, attachedTools) => promptProblems(text, attachedTools)[0]?.message ?? null;

// Filled in for every call, whoever is on it (variables.js does the filling).
export const ALWAYS_FILLED = ["customer_name", "customer_phone", "today", "now", "agent_name"];

/** The {{...}} an agent with these settings can fill in: the ones that are always
 * there, plus one per question it saves. Lives here, not in Agent.js, so Prompt.js can
 * use it without an import cycle. `detail.*` is accepted by name in `promptProblems`,
 * since those fields come from the customer's own system and differ per contact. */
export const variablesOf = (settings) => [
  ...ALWAYS_FILLED,
  ...(Array.isArray(settings?.capture_fields) ? settings.capture_fields : []).map((f) => `answer.${f.key}`),
];
