// Tags for contacts and their numbers, in a fixed palette.
import { inOrg } from "../db/pool.js";
import { hexId } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { cleanText } from "../utils/text.js";

export const TAG_COLOURS = ["marigold", "plum", "orchid", "teal", "silver", "rose"];
const MAX_TAG = 30;

async function check(db, orgId, name, colour, id = null) {
  name = cleanText(name, MAX_TAG, "tag name");
  if (!TAG_COLOURS.includes(colour)) throw new ValidationError(`colour must be one of ${TAG_COLOURS.join(", ")}`);
  const clash = await db.query("SELECT 1 FROM tags WHERE org_id = $3 AND lower(name) = lower($1) AND id IS DISTINCT FROM $2", [name, id, orgId]);
  if (clash.rowCount) throw new ValidationError(`there is already a tag called ${name}`);
  return name;
}

export async function list(orgId) {
  return (await inOrg(orgId, (db) => db.query("SELECT id, name, color FROM tags WHERE org_id = $1 ORDER BY name, id", [orgId]))).rows;
}

export async function create(orgId, name, color = "marigold") {
  try {
    return await inOrg(orgId, async (db) => {
      const clean = await check(db, orgId, name, color);
      return (await db.query("INSERT INTO tags (id, name, color, org_id) VALUES ($1, $2, $3, $4) RETURNING id, name, color",
        [hexId(), clean, color, orgId])).rows[0];
    });
  } catch (err) {
    if (err.code === "23505") throw new ValidationError(`there is already a tag called ${name}`);
    throw err;
  }
}

export async function update(orgId, id, { name, color }) {
  return inOrg(orgId, async (db) => {
    const { rows } = await db.query("SELECT * FROM tags WHERE id = $1 AND org_id = $2 FOR UPDATE", [String(id ?? ""), orgId]);
    const tag = rows[0];
    if (!tag) throw new NotFoundError("tag");
    const nextColor = color || tag.color;
    const nextName = await check(db, orgId, name || tag.name, nextColor, tag.id);
    return (await db.query("UPDATE tags SET name = $1, color = $2 WHERE id = $3 AND org_id = $4 RETURNING id, name, color",
      [nextName, nextColor, tag.id, orgId])).rows[0];
  });
}

/** Taken off every contact and number that has it (the database cascades). */
export async function remove(orgId, id) {
  const { rows } = await inOrg(orgId, (db) => db.query("DELETE FROM tags WHERE id = $1 AND org_id = $2 RETURNING name", [String(id ?? ""), orgId]));
  if (!rows[0]) throw new NotFoundError("tag");
  return rows[0];
}
