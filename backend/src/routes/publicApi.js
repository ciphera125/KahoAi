// The API another system calls, with a key. Deliberately small and separate from the
// Studio's own routes: no cookies, no session, and the organization fixed by the key.
import { Router } from "express";
import * as Task from "../models/Task.js";
import * as Contact from "../models/Contact.js";
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

export default router;
