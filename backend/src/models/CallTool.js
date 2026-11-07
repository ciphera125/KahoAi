// The tools an agent runs during a call, as the Studio sees them.
//
// The voice service sends the call id and what the model asked for. Everything that
// decides *whose* data may be touched — the organization, and the person on the phone —
// is looked up here from the call row. A model can say anything; it cannot say who it is.
//
// Every reply is shaped for the agent to act on: `ok`, and a `message` it can say when
// something could not be done. None of these throw at a live call.
import { asSystem } from "../db/pool.js";
import { logger } from "../utils/logger.js";
import { parseAnswer } from "./answerValue.js";
import * as Task from "./Task.js";
import * as Contact from "./Contact.js";
import { latestForContact } from "./CallAnswer.js";

const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const no = (message) => ({ ok: false, message });

/** The organization the call belongs to, and the contact on the other end. */
async function callSubject(callId) {
  const { rows } = await asSystem((db) => db.query(
    `SELECT c.org_id, (SELECT cn.contact_id FROM contact_numbers cn
       WHERE cn.number = c.peer AND cn.org_id = c.org_id LIMIT 1) AS contact_id
     FROM calls c WHERE c.call_id = $1`, [callId]));
  return rows[0] ?? null;
}

/** A date the caller said out loud, as an instant. Dates are read in India's day, from
 * the day of the call, by the same code that reads a saved answer. */
function dueFrom(said) {
  const read = parseAnswer("date", said, { now: new Date() });
  if (!read.ok) return read;
  // Morning of that day: a reminder is about the day, and no one says a time.
  return { ok: true, value: new Date(`${read.value}T09:00:00+05:30`) };
}

const HANDLERS = {
  /** Who the agent is speaking to: their name, what the customer's own system knows, and
   * the newest answer to each question ever saved about them. Deliberately no internal
   * ids: everything here can be said out loud. */
  async look_up_contact(subject) {
    if (!subject.contact_id) {
      return no("I do not have their details. Ask them for anything you need.");
    }
    const [contact, answers] = await Promise.all([
      Contact.summaryFor(subject.org_id, subject.contact_id),
      latestForContact(subject.org_id, subject.contact_id),
    ]);
    if (!contact) return no("I do not have their details. Ask them for anything you need.");
    return { ok: true, name: contact.name, tags: contact.tags, details: contact.details, answers };
  },

  async get_tasks(subject, args) {
    const tasks = await Task.forContactOnCall(subject.org_id, subject.contact_id, {
      range: ["today", "yesterday", "this_week", "overdue", "all"].includes(args.range) ? args.range : "all",
      status: ["pending", "done", "all"].includes(args.status) ? args.status : "pending",
    });
    return { ok: true, tasks, count: tasks.length };
  },

  async add_task(subject, args, { idem }) {
    if (!subject.contact_id) return no("I do not know whose list to add that to. Carry on with the call.");
    const title = String(args.title ?? "").trim();
    if (!title) return no("I did not catch what the task is. Please ask again.");
    let due = null;
    if (args.due) {
      const read = dueFrom(args.due);
      if (!read.ok) return no(read.message);
      due = read.value;
    }
    const task = await Task.create(subject.org_id,
      { title, due_at: due, contact_id: subject.contact_id, external_id: idem }, { source: "call" });
    return { ok: true, task_id: task.id, title: task.title, due: task.due_at };
  },

  async reschedule_task(subject, args) {
    const id = await Task.ownedByContact(subject.org_id, subject.contact_id, args.task_id);
    if (!id) return no("I could not find that task on their list. Please check with them.");
    const read = dueFrom(args.due);
    if (!read.ok) return no(read.message);
    const task = await Task.update(subject.org_id, id, { due_at: read.value });
    return { ok: true, task_id: task.id, due: task.due_at };
  },

  async mark_task_done(subject, args) {
    const id = await Task.ownedByContact(subject.org_id, subject.contact_id, args.task_id);
    if (!id) return no("I could not find that task on their list. Please check with them.");
    const task = await Task.update(subject.org_id, id, { status: "done" });
    return { ok: true, task_id: task.id, title: task.title };
  },
};

export const TOOLS = Object.keys(HANDLERS);

export async function run(callId, tool, args = {}) {
  if (typeof callId !== "string" || !CALL_ID.test(callId)) return no("I could not do that. Carry on.");
  const handler = HANDLERS[tool];
  if (!handler) return no("I cannot do that on this call.");
  const subject = await callSubject(callId);
  if (!subject?.org_id) return no("I could not do that just now. Carry on with the call.");
  // call + tool + turn: the same request twice on one turn must not make two tasks.
  const idem = `${callId}:${tool}:${Number.isFinite(Number(args.turn)) ? Number(args.turn) : 0}`;
  try {
    return await handler(subject, args, { idem });
  } catch (err) {
    logger.warn({ err: err.message, tool }, "a tool failed during a call");
    return no("I could not do that just now. Please carry on.");
  }
}
