// Answers the agent collected on a call: "On what date will you pay?" -> 2026-12-15.
//
// The voice service sends only the field and what it heard. Everything that decides who
// the answer belongs to — the organization and the contact — is looked up here from the
// call, never taken from the request, because the model is on the other end of it and a
// model can be talked into anything.
import { asSystem, inOrg } from "../db/pool.js";
import { NotFoundError } from "../utils/errors.js";
import { maskSensitive } from "../utils/masking.js";
import { needsConfirming, parseAnswer } from "./answerValue.js";
import { callConfig } from "./Agent.js";

const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const say = (message, value = null) => ({ ok: false, value, message });

/** The call's organization, the agent that answered it, and the contact whose number it
 * was. All three come from the call itself and nothing else: the request is the model's
 * word, and a model can say anything. */
async function whose(db, callId) {
  const { rows } = await db.query(
    `SELECT c.org_id, c.peer, c.agent_id,
       (SELECT cn.contact_id FROM contact_numbers cn
        WHERE cn.number = c.peer AND cn.org_id = c.org_id LIMIT 1) AS contact_id
     FROM calls c WHERE c.call_id = $1`, [callId]);
  return rows[0] ?? null;
}

/**
 * Save one answer. Always answers the agent with something it can say; never throws at a
 * live call. `confirmed` is the caller having heard the value read back and agreed.
 */
export async function record(callId, { field_key: fieldKey, said, turn, confirmed } = {}) {
  if (typeof callId !== "string" || !CALL_ID.test(callId)) return say("I could not save that. Please carry on.");

  // Which agent's questions apply is the agent that answered this call. The voice service
  // does not say, and nothing in the request is allowed to: an agent named in the body
  // would let a call save into another agent's fields.
  const call = await asSystem((db) => whose(db, callId));
  if (!call?.agent_id) return say("I could not save that just now. Please carry on.");
  const config = await callConfig(call.agent_id);
  const field = (config?.capture_fields ?? []).find((f) => f.key === fieldKey);
  if (!field) {
    // The model asked for a field this agent does not have: the same class of mistake as
    // a tool it does not have (2026-11-07). Tell it plainly rather than inventing a place
    // to put the answer.
    return say("There is nothing to save under that name. Carry on with the call.");
  }

  const read = parseAnswer(field.kind, said, { now: new Date(), choices: field.choices });
  if (!read.ok) return read;

  if (config.confirm_answers !== false && needsConfirming(field.kind) && !confirmed) {
    return say(`Read it back to the caller and get a yes first, then save it again.`, read.value);
  }

  const value = maskSensitive(read.value);
  const rawText = maskSensitive(String(said ?? "").slice(0, 500));
  // call + field + turn: a retry of the same turn updates the one row instead of adding.
  const idem = `${callId}:${field.key}:${Number.isFinite(Number(turn)) ? Number(turn) : 0}`;

  await asSystem(async (db) => {
    await db.query(
      `INSERT INTO call_answers (org_id, call_id, contact_id, field_key, label, kind, value, raw_text, source, idem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'tool_call', $9)
       ON CONFLICT (idem) DO UPDATE SET value = EXCLUDED.value, raw_text = EXCLUDED.raw_text, at = now()`,
      [call?.org_id ?? null, callId, call?.contact_id ?? null, field.key, field.label, field.kind, value, rawText, idem]);
  });
  return { ok: true, value, message: null };
}

const shape = (r) => ({ id: String(r.id), call_id: r.call_id, contact_id: r.contact_id, field_key: r.field_key,
  label: r.label, kind: r.kind, value: r.value, raw_text: r.raw_text, source: r.source, at: r.at.toISOString() });

/** Everything saved on one call, oldest first. */
export async function forCall(orgId, callId) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    "SELECT * FROM call_answers WHERE call_id = $1 AND org_id = $2 ORDER BY at, id",
    [typeof callId === "string" ? callId : "", orgId]));
  return rows.map(shape);
}

/** Everything ever saved about one contact, newest first. */
export async function forContact(orgId, contactId) {
  const { rows } = await inOrg(orgId, async (db) => {
    const own = await db.query("SELECT 1 FROM contacts WHERE id = $1 AND org_id = $2", [String(contactId), orgId]);
    if (!own.rowCount) throw new NotFoundError("contact");
    return db.query("SELECT * FROM call_answers WHERE contact_id = $1 AND org_id = $2 ORDER BY at DESC, id DESC",
      [String(contactId), orgId]);
  });
  return rows.map(shape);
}

/** The newest answer for each field, for {{answer.payment_date}} in a prompt. */
export async function latestForContact(orgId, contactId) {
  const { rows } = await inOrg(orgId, (db) => db.query(
    `SELECT DISTINCT ON (field_key) field_key, value FROM call_answers
     WHERE contact_id = $1 AND org_id = $2 ORDER BY field_key, at DESC, id DESC`, [String(contactId), orgId]));
  return Object.fromEntries(rows.map((r) => [r.field_key, r.value]));
}
