// The Billing tab and the plan choice, for the people of one organization. Money and minutes are decided
// in models/Billing.js; this only carries a person's request there and the answer back.
import * as Requests from "../models/Requests.js";
import * as Billing from "../models/Billing.js";
import { ValidationError } from "../utils/errors.js";

export async function plans(_req, res) {
  res.json(await Billing.listPlans());
}

export async function overview(req, res) {
  res.json(await Billing.overview(req.user.org_id));
}

export async function summary(req, res) {
  res.json(await Billing.summary(req.user.org_id));
}

export async function ledger(req, res) {
  res.json(await Billing.ledgerPage(req.user.org_id, { page: req.query.page, perPage: req.query.per_page }));
}

export async function topups(req, res) {
  res.json(await Billing.listTopups(req.user.org_id));
}

export async function subscribe(req, res) {
  res.json(await Billing.subscribe(req.user.org_id, req.body?.plan_id, { userName: req.user.name }));
}

export async function changeRequest(req, res) {
  res.json(await Billing.requestChange(req.user.org_id, req.body?.plan_id, req.body?.note, { userName: req.user.name }));
}

/** A message to Kaho, from someone who manages billing. The team is told that one was sent, never what it says. */
export async function writeToKaho(req, res) {
  const out = await Requests.create(req.user.org_id, { kind: "message", message: req.body?.message, userName: req.user.name });
  await Billing.tell(req.user.org_id, `${req.user.name} sent a request to Kaho. Kaho will answer here.`, { actor: req.user.name, role: req.user.role });
  res.json(out);
}
export async function requests(req, res) { res.json(await Requests.listForOrg(req.user.org_id)); }

export async function createTopup(req, res) {
  if (req.body?.minutes === undefined) throw new ValidationError("say how many minutes");
  res.json(await Billing.createTopup(req.user.org_id, { userId: req.user.id, userName: req.user.name, minutes: req.body.minutes }));
}

export async function cancelTopup(req, res) {
  res.json(await Billing.cancelTopup(req.user.org_id, req.params.id, { userName: req.user.name }));
}
