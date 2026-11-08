// The API another system calls, with a key. Deliberately small and separate from the
// Studio's own routes: no cookies, no session, and the organization fixed by the key.
import { Router } from "express";
import * as Task from "../models/Task.js";
import * as Contact from "../models/Contact.js";
import * as Agent from "../models/Agent.js";
import * as Call from "../models/Call.js";
import * as CallAnswer from "../models/CallAnswer.js";
import { OutsideWindowError, placeCall } from "../services/calling.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { normalizeNumber } from "../utils/phone.js";

const router = Router();

/** Push a task in. `external_id` makes it safe to send the same one twice. A `phone`
 * ties it to the contact with that number, inside this organization only. */
router.post("/tasks", async (req, res) => {
  const org = req.apiOrgId;
  const { title, due_at: dueAt, external_id: externalId, phone } = req.body ?? {};
  let contactId = null;
  if (phone) {
    try { contactId = await Contact.idForNumber(org, normalizeNumber(String(phone))); } catch { contactId = null; }
  }
  const task = await Task.create(org, { title, due_at: dueAt, external_id: externalId, contact_id: contactId },
    { source: "api" });
  res.json(task);
});

router.get("/tasks", async (req, res) => {
  res.json(await Task.list(req.apiOrgId, { range: req.query.range ?? "all", status: req.query.status ?? "all" }));
});

/** Make or update a contact, found by phone number, inside this key's organization. */
router.post("/contacts", async (req, res) => {
  const { phone, name, details } = req.body ?? {};
  res.json(await Contact.upsertByNumber(req.apiOrgId, { phone, name, details }));
});

/** The agents a system can place calls with. Names only: prompts stay in the Studio. */
router.get("/agents", async (req, res) => {
  res.json((await Agent.list(req.apiOrgId)).map((a) => ({ id: a.id, name: a.name, description: a.description })));
});

/** Place a call. Same rules as the Studio: consent stated, Do not call honoured, calling hours kept. */
router.post("/calls", async (req, res) => {
  const body = req.body ?? {};
  if (body.consent !== true) throw new ValidationError("confirm that this person has agreed to be called");
  try {
    const placed = await placeCall(req.apiOrgId, { fromId: body.from_id, to: body.to, agentId: body.agent_id,
      language: typeof body.language === "string" ? body.language : null });
    res.json({ to: placed.to, from: placed.from, request_uuid: placed.request_uuid, agent_name: placed.agent?.name ?? null });
  } catch (err) {
    if (err instanceof OutsideWindowError) return res.status(400).json({ error: err.message, code: err.code, call_window: err.window });
    throw err;
  }
});

/** The organization's calls, newest first. */
router.get("/calls", async (req, res) => {
  const page = await Call.page(req.apiOrgId, { page: req.query.page, perPage: req.query.per_page });
  res.json({ ...page, calls: page.calls.map(({ call_id: id, peer, direction, started_at: startedAt, duration_secs: secs, summary }) =>
    ({ call_id: id, peer, direction, started_at: startedAt, duration_secs: secs, summary })) });
});

/** One call: how it went, what the agent saved, and what was said. */
router.get("/calls/:callId", async (req, res) => {
  const org = req.apiOrgId;
  if (!(await Call.owns(org, req.params.callId))) throw new NotFoundError("call");
  const [meta, turns, answers, page] = await Promise.all([
    Call.forFiles(org, req.params.callId), Call.turns(org, req.params.callId),
    CallAnswer.forCall(org, req.params.callId), Call.summaryOf(org, req.params.callId)]);
  res.json({ call_id: req.params.callId, agent_id: meta.agentId ?? null, peer: meta.peer, started_at: meta.startedAt,
    duration_secs: meta.durationSecs, direction: page.direction, summary: page.summary, lead: page.lead, sentiment: page.sentiment,
    answers: answers.map((a) => ({ key: a.field_key, label: a.label, kind: a.kind, value: a.value })),
    transcript: turns });
});

export default router;