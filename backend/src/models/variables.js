// The {{...}} a prompt may use, and what they are worth on a given call.
//
// The point of these is that the agent never asks for something we already know. They
// are filled in before the call starts, so the model is handed plain words and cannot
// read a variable out loud by mistake, or be talked into revealing the shape of them.
//
// A variable with nothing behind it on this call becomes an empty string rather than
// staying as {{...}}: hearing "Hello, curly curly customer name" is the worst outcome,
// and promptCheck already refuses to publish a prompt using one we cannot fill at all.
import { inOrg } from "../db/pool.js";
import * as Contact from "./Contact.js";

const PATTERN = /\{\{\s*([A-Za-z0-9_.]{1,60})\s*\}\}/g;
const TZ = "Asia/Kolkata";

/** Always available, whoever is on the call. */
export const SYSTEM_VARIABLES = [
  { name: "today", label: "Today's date", example: "Monday, 9 November 2026" },
  { name: "now", label: "The time now", example: "3:30 pm" },
  { name: "agent_name", label: "This agent's name", example: "Ria" },
];

/** Known about the person being called. */
export const CONTACT_VARIABLES = [
  { name: "customer_name", label: "Their name", example: "Ravi Kumar" },
  { name: "customer_phone", label: "Their number", example: "+919876543210" },
];

function systemValues(now, agentName) {
  return {
    today: new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "long", day: "numeric",
      month: "long", year: "numeric" }).format(now),
    now: new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit",
      hour12: true }).format(now),
    agent_name: agentName ?? "",
  };
}

/**
 * Everything this agent could offer in the prompt editor, grouped the way the picker
 * shows it. `detailKeys` are the fields this organization's own system actually sends,
 * so the list is what they really have rather than what they might.
 */
export function offered({ captureFields = [], detailKeys = [] } = {}) {
  return [
    { group: "Contact details", items: [...CONTACT_VARIABLES,
      ...detailKeys.map((k) => ({ name: `detail.${k}`, label: k.replace(/_/g, " "), example: "" }))] },
    { group: "Saved answers", items: captureFields.map((f) => ({
      name: `answer.${f.key}`, label: f.label, example: "" })) },
    { group: "About the call", items: SYSTEM_VARIABLES },
  ];
}

/** Every name the picker offers, flat: what promptCheck accepts. */
export const namesOf = (groups) => groups.flatMap((g) => g.items.map((i) => i.name));

/** The newest answer for each question ever saved about this contact. Queried here
 * rather than through CallAnswer.js, which would make Agent.js and CallAnswer.js import
 * each other through this file. */
async function latestAnswers(orgId, contactId) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    `SELECT DISTINCT ON (field_key) field_key, value FROM call_answers
     WHERE contact_id = $1 AND org_id = $2 ORDER BY field_key, at DESC, id DESC`, [String(contactId), orgId]));
  return Object.fromEntries(rows.map((r) => [r.field_key, r.value]));
}

/**
 * Fill a prompt in for one call. `contactId` may be null (we do not know who is
 * calling), in which case the contact's own variables come out empty.
 */
export async function fill(text, { orgId, contactId = null, phone = null, agentName = "", now = new Date() } = {}) {
  if (typeof text !== "string" || !text.includes("{{")) return text;

  const values = systemValues(now, agentName);
  values.customer_phone = phone ?? "";
  if (contactId) {
    const [contact, answers] = await Promise.all([
      Contact.summaryFor(orgId, contactId).catch(() => null),
      latestAnswers(orgId, contactId).catch(() => ({})),
    ]);
    values.customer_name = contact?.name ?? "";
    for (const [key, value] of Object.entries(contact?.details ?? {})) values[`detail.${key}`] = String(value);
    for (const [key, value] of Object.entries(answers)) values[`answer.${key}`] = String(value);
  } else {
    values.customer_name = "";
  }
  return text.replace(PATTERN, (_, name) => values[name] ?? "");
}
