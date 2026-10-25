// Counts across one organization, for the profile.
import { inOrg } from "../db/pool.js";

export async function counts(orgId) {
  const { rows: [c] } = await inOrg(orgId, (db) => db.query(`SELECT
    (SELECT count(*) FROM phone_numbers WHERE org_id = $1)::int AS numbers,
    (SELECT count(*) FROM agents WHERE org_id = $1)::int AS agents,
    (SELECT count(*) FROM prompts WHERE org_id = $1)::int AS prompts,
    (SELECT count(*) FROM contacts WHERE org_id = $1)::int AS contacts,
    (SELECT count(*) FROM calls WHERE org_id = $1)::int AS calls,
    (SELECT count(*) FROM users WHERE org_id = $1)::int AS members`, [orgId]));
  return c;
}
