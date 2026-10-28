// Contacts: people, their numbers, and tags on either. Always one organization's.
import { asSystem, inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { normalizeNumber } from "../utils/phone.js";
import { cleanText } from "../utils/text.js";
import { STATUS_SQL, SUCCESS_SQL } from "./Call.js";

const MAX_NAME = 80;
const MAX_NUMBERS = 50;
export const PAGE_SIZES = [10, 20, 25, 50, 100];

const SHOW = `SELECT c.id, c.name, c.dnc, c.consent, c.created_at,
    coalesce((SELECT array_agg(ct.tag_id ORDER BY ct.position) FROM contact_tags ct WHERE ct.contact_id = c.id), '{}') AS tags,
    coalesce((SELECT json_agg(json_build_object('id', n.id, 'number', n.number, 'tags',
        coalesce((SELECT array_agg(nt.tag_id ORDER BY nt.position) FROM contact_number_tags nt WHERE nt.number_id = n.id), '{}'))
      ORDER BY n.position) FROM contact_numbers n WHERE n.contact_id = c.id), '[]') AS numbers`;

const CALL_STATS = `,
    (SELECT count(*) FROM calls k WHERE k.org_id = c.org_id
       AND k.peer IN (SELECT number FROM contact_numbers WHERE contact_id = c.id))::int AS call_count,
    (SELECT json_build_object('call_id', k.call_id, 'started_at', k.started_at, 'status', ${STATUS_SQL},
        'duration_secs', k.duration_secs, 'summary', k.summary, 'successful', ${SUCCESS_SQL})
      FROM calls k WHERE k.org_id = c.org_id AND k.peer IN (SELECT number FROM contact_numbers WHERE contact_id = c.id)
      ORDER BY k.started_at DESC NULLS LAST LIMIT 1) AS last_call`;

const shape = (r) => ({ id: r.id, name: r.name, created_at: r.created_at.toISOString(), tags: r.tags, numbers: r.numbers,
  dnc: r.dnc, consent: r.consent, ...(r.call_count !== undefined ? { call_count: r.call_count, last_call: r.last_call } : {}) });

const name = (raw) => cleanText(raw, MAX_NAME, "name");

function asList(raw, what) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError(`${what} must be a list`);
  return raw;
}

async function checkTags(db, orgId, tags) {
  const ids = [...new Set(asList(tags, "tags").map(String))];
  if (ids.length) {
    const { rows } = await db.query("SELECT count(*)::int AS n FROM tags WHERE id = ANY($1) AND org_id = $2", [ids, orgId]);
    if (rows[0].n !== ids.length) throw new ValidationError("unknown tag");
  }
  return ids;
}

async function show(db, orgId, id) {
  const { rows } = await db.query(`${SHOW} FROM contacts c WHERE c.id = $1 AND c.org_id = $2`, [String(id ?? ""), orgId]);
  if (!rows[0]) throw new NotFoundError("contact");
  return shape(rows[0]);
}

async function lock(db, orgId, id) {
  const { rows } = await db.query("SELECT * FROM contacts WHERE id = $1 AND org_id = $2 FOR UPDATE", [String(id ?? ""), orgId]);
  if (!rows[0]) throw new NotFoundError("contact");
  return rows[0];
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One page of contacts, oldest first, matching `q` (a name, part of a number,
 * or a tag) if given, with how many calls each had and the newest one. */
export async function page(orgId, { page: p = 1, perPage = 25, q = "", consent } = {}) {
  const size = Number(perPage);
  if (!PAGE_SIZES.includes(size)) throw new ValidationError(`per_page must be one of ${PAGE_SIZES.join(", ")}`);
  const n = Math.max(1, Math.floor(Number(p)) || 1);
  const text = String(q ?? "").trim().slice(0, 80);
  const digits = text.replace(/\D/g, "");
  const params = [orgId];
  let where = "c.org_id = $1";
  if (consent && ["pending", "given", "refused"].includes(consent)) {
    params.push(consent);
    where += ` AND c.consent = $${params.length}`;
  }
  if (text) {
    params.push(`%${likeEscape(text.toLowerCase())}%`);
    const conds = [`lower(c.name) LIKE $${params.length}`,
      `EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id AND lower(t.name) LIKE $${params.length})`];
    if (digits.length >= 3) {
      params.push(`%${digits}%`);
      conds.push(`EXISTS (SELECT 1 FROM contact_numbers n WHERE n.contact_id = c.id AND n.number LIKE $${params.length})`);
    }
    where += ` AND (${conds.join(" OR ")})`;
  }
  return inOrg(orgId, async (db) => {
    const total = (await db.query(`SELECT count(*)::int AS n FROM contacts c WHERE ${where}`, params)).rows[0].n;
    const { rows } = await db.query(`${SHOW}${CALL_STATS} FROM contacts c WHERE ${where}
      ORDER BY c.created_at, c.id LIMIT ${size} OFFSET ${(n - 1) * size}`, params);
    return { total, page: n, per_page: size, contacts: rows.map(shape) };
  });
}

/** Up to 10 contacts' callable numbers matching `q`, for the call form. Do-not-call contacts are left out. */
export async function lookup(orgId, q) {
  const text = String(q ?? "").trim().slice(0, 80);
  if (!text) return [];
  const digits = text.replace(/\D/g, "");
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT c.name, n.number FROM contacts c
      JOIN contact_numbers n ON n.contact_id = c.id
    WHERE c.org_id = $1 AND NOT c.dnc AND (lower(c.name) LIKE $2 OR ($3 <> '' AND n.number LIKE '%' || $3 || '%'))
    ORDER BY c.name, n.position LIMIT 10`, [orgId, `%${likeEscape(text.toLowerCase())}%`, digits.length >= 3 ? digits : ""]));
  return rows;
}

export const get = (orgId, id) => inOrg(orgId, (db) => show(db, orgId, id));

export async function create(orgId, { name: raw, numbers, tags }) {
  const clean = [];
  for (const n of asList(numbers, "numbers").slice(0, MAX_NUMBERS)) {
    const number = normalizeNumber(n);
    if (!clean.includes(number)) clean.push(number);
  }
  const contactName = name(raw);
  return inOrg(orgId, async (db) => {
    const tagIds = await checkTags(db, orgId, tags);
    const id = hexId();
    await db.query("INSERT INTO contacts (id, name, org_id) VALUES ($1, $2, $3)", [id, contactName, orgId]);
    for (const [i, number] of clean.entries()) {
      await db.query("INSERT INTO contact_numbers (id, contact_id, number, position, org_id) VALUES ($1, $2, $3, $4, $5)",
        [hexId(), id, number, i, orgId]);
    }
    for (const [i, tag] of tagIds.entries()) {
      await db.query("INSERT INTO contact_tags (contact_id, tag_id, position, org_id) VALUES ($1, $2, $3, $4)", [id, tag, i, orgId]);
    }
    return show(db, orgId, id);
  });
}

export async function update(orgId, id, body) {
  return inOrg(orgId, async (db) => {
    await lock(db, orgId, id);
    if ("name" in body) await db.query("UPDATE contacts SET name = $1 WHERE id = $2 AND org_id = $3", [name(body.name), id, orgId]);
    if ("tags" in body) {
      const tagIds = await checkTags(db, orgId, body.tags);
      await db.query("DELETE FROM contact_tags WHERE contact_id = $1 AND org_id = $2", [id, orgId]);
      for (const [i, tag] of tagIds.entries()) {
        await db.query("INSERT INTO contact_tags (contact_id, tag_id, position, org_id) VALUES ($1, $2, $3, $4)", [id, tag, i, orgId]);
      }
    }
    if ("dnc" in body) await db.query("UPDATE contacts SET dnc = $1 WHERE id = $2 AND org_id = $3", [body.dnc === true, id, orgId]);
    if ("consent" in body) {
      const v = String(body.consent);
      if (!["pending", "given", "refused"].includes(v)) throw new ValidationError("consent must be pending, given or refused");
      await db.query("UPDATE contacts SET consent = $1 WHERE id = $2 AND org_id = $3", [v, id, orgId]);
    }
    return show(db, orgId, id);
  });
}

export async function remove(orgId, id) {
  const { rows } = await inOrg(orgId, (db) => db.query("DELETE FROM contacts WHERE id = $1 AND org_id = $2 RETURNING name",
    [String(id ?? ""), orgId]));
  if (!rows[0]) throw new NotFoundError("contact");
  return rows[0];
}

export async function removeMany(orgId, ids) {
  const list = asList(ids, "ids").map(String).slice(0, 10000);
  return (await inOrg(orgId, (db) => db.query("DELETE FROM contacts WHERE id = ANY($1) AND org_id = $2", [list, orgId]))).rowCount;
}

async function numberTags(db, orgId, numberId, tags) {
  const tagIds = await checkTags(db, orgId, tags);
  await db.query("DELETE FROM contact_number_tags WHERE number_id = $1 AND org_id = $2", [numberId, orgId]);
  for (const [i, tag] of tagIds.entries()) {
    await db.query("INSERT INTO contact_number_tags (number_id, tag_id, position, org_id) VALUES ($1, $2, $3, $4)", [numberId, tag, i, orgId]);
  }
}

async function showNumber(db, orgId, numberId) {
  const { rows } = await db.query(`SELECT n.id, n.number,
      coalesce((SELECT array_agg(nt.tag_id ORDER BY nt.position) FROM contact_number_tags nt WHERE nt.number_id = n.id), '{}') AS tags
    FROM contact_numbers n WHERE n.id = $1 AND n.org_id = $2`, [numberId, orgId]);
  return rows[0];
}

export async function addNumber(orgId, contactId, raw, tags) {
  const number = normalizeNumber(raw);
  return inOrg(orgId, async (db) => {
    await lock(db, orgId, contactId);
    const { rows } = await db.query("SELECT number FROM contact_numbers WHERE contact_id = $1 AND org_id = $2", [contactId, orgId]);
    if (rows.some((r) => r.number === number)) throw new ValidationError(`${number} is already on this contact`);
    if (rows.length >= MAX_NUMBERS) throw new ValidationError(`a contact can have at most ${MAX_NUMBERS} numbers`);
    const id = hexId();
    await db.query(`INSERT INTO contact_numbers (id, contact_id, number, position, org_id)
      VALUES ($1, $2, $3, (SELECT coalesce(max(position) + 1, 0) FROM contact_numbers WHERE contact_id = $2), $4)`,
    [id, contactId, number, orgId]);
    await numberTags(db, orgId, id, tags);
    return showNumber(db, orgId, id);
  });
}

export async function updateNumber(orgId, contactId, numberId, { number: raw, tags }) {
  return inOrg(orgId, async (db) => {
    await lock(db, orgId, contactId).catch(() => { throw new NotFoundError("number"); });
    const own = await db.query("SELECT 1 FROM contact_numbers WHERE id = $1 AND contact_id = $2 AND org_id = $3",
      [String(numberId), contactId, orgId]);
    if (!own.rowCount) throw new NotFoundError("number");
    if (raw !== undefined && raw !== null) {
      const number = normalizeNumber(raw);
      const clash = await db.query("SELECT 1 FROM contact_numbers WHERE contact_id = $1 AND number = $2 AND id <> $3",
        [contactId, number, numberId]);
      if (clash.rowCount) throw new ValidationError(`${number} is already on this contact`);
      await db.query("UPDATE contact_numbers SET number = $1 WHERE id = $2 AND org_id = $3", [number, numberId, orgId]);
    }
    if (tags !== undefined && tags !== null) await numberTags(db, orgId, numberId, tags);
    return showNumber(db, orgId, numberId);
  });
}

export async function removeNumber(orgId, contactId, numberId) {
  const { rowCount } = await inOrg(orgId, (db) => db.query(
    "DELETE FROM contact_numbers WHERE id = $1 AND contact_id = $2 AND org_id = $3", [String(numberId), String(contactId), orgId]));
  if (!rowCount) throw new NotFoundError("number");
}

/** Do not call, within one organization: none of its people dial this number. */
export async function isDnc(orgId, number) {
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT EXISTS (SELECT 1 FROM contacts c
    JOIN contact_numbers n ON n.contact_id = c.id WHERE c.org_id = $1 AND c.dnc AND n.number = $2) AS dnc`,
  [orgId, normalizeNumber(number)]));
  return rows[0].dnc;
}

/** {number: contact name}, for the given numbers only. */
export async function namesFor(orgId, numbers) {
  const wanted = [...new Set(numbers.filter(Boolean))];
  if (!wanted.length) return {};
  const { rows } = await inOrg(orgId, (db) => db.query(`SELECT DISTINCT ON (n.number) n.number, c.name FROM contact_numbers n
    JOIN contacts c ON c.id = n.contact_id WHERE c.org_id = $1 AND n.number = ANY($2) ORDER BY n.number, c.created_at`, [orgId, wanted]));
  return Object.fromEntries(rows.map((r) => [r.number, r.name]));
}

export async function numbersOf(orgId, contactId) {
  await get(orgId, contactId);
  const { rows } = await inOrg(orgId, (db) => db.query("SELECT number FROM contact_numbers WHERE contact_id = $1 AND org_id = $2",
    [contactId, orgId]));
  return rows.map((r) => r.number);
}

/** Whether any organization has this number on Do not call (the voice service, when it cannot tell whose call it is). */
export async function isDncAnywhere(number) {
  const { rows } = await asSystem((db) => db.query(`SELECT EXISTS (SELECT 1 FROM contacts c
    JOIN contact_numbers n ON n.contact_id = c.id WHERE c.dnc AND n.number = $1) AS dnc`, [normalizeNumber(number)]));
  return rows[0].dnc;
}
