import * as Contact from "../models/Contact.js";
import * as Tag from "../models/Tag.js";
import { note } from "./notify.js";

export async function list(req, res) {
  res.json(await Contact.page(req.user.org_id, { page: req.query.page, perPage: req.query.per_page ?? 25, q: req.query.q }));
}

export async function lookup(req, res) {
  res.json(await Contact.lookup(req.user.org_id, req.query.q));
}

export async function create(req, res) {
  const { name, numbers, tags } = req.body ?? {};
  const contact = await Contact.create(req.user.org_id, { name, numbers, tags });
  await note(req, "contact", `Added the contact ${contact.name}`, "contacts", contact.id);
  res.json(contact);
}

export async function update(req, res) {
  const body = req.body ?? {};
  const before = await Contact.get(req.user.org_id, req.params.contactId);
  const contact = await Contact.update(req.user.org_id, req.params.contactId, body);
  if ("name" in body && contact.name !== before.name) {
    await note(req, "contact", `Renamed ${before.name} to ${contact.name}`, "contacts", contact.id);
  }
  if ("dnc" in body) {
    await note(req, "contact", `${contact.name} is ${contact.dnc ? "now Do not call" : "callable again"}`, "contacts", contact.id);
  }
  if ("tags" in body && [...contact.tags].sort().join() !== [...before.tags].sort().join()) {
    await note(req, "contact", `Changed the tags on ${contact.name}`, "contacts", contact.id);
  }
  res.json(contact);
}

export async function remove(req, res) {
  const { name } = await Contact.remove(req.user.org_id, req.params.contactId);
  await note(req, "contact", `Deleted the contact ${name}`, "contacts");
  res.json({ deleted: req.params.contactId });
}

export async function removeMany(req, res) {
  const n = await Contact.removeMany(req.user.org_id, req.body?.ids ?? []);
  if (n) await note(req, "contact", `Deleted ${n} contact${n === 1 ? "" : "s"}`, "contacts");
  res.json({ deleted: n });
}

export async function addNumber(req, res) {
  res.json(await Contact.addNumber(req.user.org_id, req.params.contactId, req.body?.number, req.body?.tags));
}

export async function updateNumber(req, res) {
  const entry = await Contact.updateNumber(req.user.org_id, req.params.contactId, req.params.numberId,
    { number: req.body?.number, tags: req.body?.tags });
  if (req.body?.number) {
    const { name } = await Contact.get(req.user.org_id, req.params.contactId);
    await note(req, "contact", `Changed a number of ${name}`, "contacts", req.params.contactId);
  }
  res.json(entry);
}

export async function removeNumber(req, res) {
  await Contact.removeNumber(req.user.org_id, req.params.contactId, req.params.numberId);
  res.json({ deleted: req.params.numberId });
}

export async function listTags(req, res) {
  res.json(await Tag.list(req.user.org_id));
}

export async function createTag(req, res) {
  const tag = await Tag.create(req.user.org_id, req.body?.name, req.body?.color || "marigold");
  await note(req, "tag", `Created the tag ${tag.name}`, "contacts");
  res.json(tag);
}

export async function updateTag(req, res) {
  res.json(await Tag.update(req.user.org_id, req.params.tagId, { name: req.body?.name, color: req.body?.color }));
}

export async function removeTag(req, res) {
  const { name } = await Tag.remove(req.user.org_id, req.params.tagId);
  await note(req, "tag", `Deleted the tag ${name}`, "contacts");
  res.json({ deleted: req.params.tagId });
}
