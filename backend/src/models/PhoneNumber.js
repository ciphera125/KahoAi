// Our phone numbers, the provider each is on, and that provider's credentials.
//
// Plivo is the only provider the voice service can place and take calls on
// today; Exotel, Twilio and SIP trunk numbers can be saved but show as not
// connected. Our Plivo number from the environment is listed from the start
// without copying its token into the database; a token saved here wins.
// Credentials are encrypted at rest and leave this model in full only through
// credentials(), for the dialler. listPublic() masks every secret.
import { config } from "../config/env.js";
import { asSystem, inOrg } from "../db/pool.js";
import { decryptJson, encryptJson, hexId } from "../utils/crypto.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { normalizeNumber } from "../utils/phone.js";
import { logger } from "../utils/logger.js";

// field name, label, secret
export const PROVIDERS = {
  plivo: { label: "Plivo", connected: true, fields: [["auth_id", "Auth ID", false], ["auth_token", "Auth token", true]] },
  exotel: { label: "Exotel", connected: false, fields: [["account_sid", "Account SID", false], ["api_key", "API key", false],
    ["api_token", "API token", true], ["subdomain", "Subdomain (api.in.exotel.com)", false]] },
  twilio: { label: "Twilio", connected: false, fields: [["account_sid", "Account SID", false], ["auth_token", "Auth token", true]] },
  sip: { label: "SIP trunk", connected: false, fields: [["sip_host", "SIP host or domain", false], ["username", "Username", false],
    ["password", "Password", true], ["transport", "Transport (udp, tcp or tls)", false]] },
};

export const mask = (value) => (value ? `••••${String(value).slice(-4)}` : "");

/** Our Plivo number from the environment goes to the first organization, once;
 * a deleted one stays deleted. No other organization ever sees it. */
export async function ensureSeeded(orgId) {
  let number;
  try { number = normalizeNumber(config.PLIVO_FROM_NUMBER || ""); } catch { return; }
  await asSystem(async (db) => {
    const first = (await db.query("SELECT id FROM organizations ORDER BY created_at, id LIMIT 1")).rows[0]?.id;
    if (first !== orgId) return;
    const done = await db.query("INSERT INTO meta (key, value) VALUES ('numbers_seeded', $1) ON CONFLICT DO NOTHING", [number]);
    if (!done.rowCount) return;
    const any = await db.query("SELECT 1 FROM phone_numbers WHERE is_default AND org_id = $1 LIMIT 1", [orgId]);
    await db.query(`INSERT INTO phone_numbers (id, provider, number, label, env_backed, is_default, org_id)
      VALUES ($1, 'plivo', $2, 'Main line', true, $3, $4) ON CONFLICT (number) DO NOTHING`, [hexId(), number, !any.rowCount, orgId]);
  });
}

function credentialsOf(row) {
  let stored = {};
  try { stored = decryptJson(row.credentials_enc); } catch (err) {
    logger.error({ err: err.message, number: row.id }, "stored credentials could not be decrypted (SECRETS_KEY changed?)");
  }
  stored = Object.fromEntries(Object.entries(stored).filter(([, v]) => v));
  if (row.env_backed && row.provider === "plivo") {
    return { auth_id: config.PLIVO_AUTH_ID || "", auth_token: config.PLIVO_AUTH_TOKEN || "", ...stored };
  }
  return stored;
}

function status(row, creds) {
  const p = PROVIDERS[row.provider];
  if (!p.connected) return "not_connected";
  return p.fields.every(([f]) => creds[f]) ? "active" : "incomplete";
}

function toPublic(row) {
  const p = PROVIDERS[row.provider];
  const creds = credentialsOf(row);
  return { id: row.id, provider: row.provider, provider_label: p.label, number: row.number, label: row.label,
    is_default: row.is_default, status: status(row, creds),
    credentials_from_env: row.env_backed && !row.credentials_enc,
    credentials: Object.fromEntries(p.fields.map(([f, , secret]) => [f, secret ? mask(creds[f]) : creds[f] || ""])),
    updated_at: row.updated_at.toISOString() };
}

export async function listPublic(orgId) {
  await ensureSeeded(orgId);
  return (await inOrg(orgId, (db) => db.query("SELECT * FROM phone_numbers WHERE org_id = $1 ORDER BY created_at, id", [orgId]))).rows.map(toPublic);
}

async function row(orgId, id) {
  const { rows } = await inOrg(orgId, (db) => db.query("SELECT * FROM phone_numbers WHERE id = $1 AND org_id = $2", [String(id ?? ""), orgId]));
  if (!rows[0]) throw new NotFoundError("number");
  return rows[0];
}

export const getPublic = async (orgId, id) => toPublic(await row(orgId, id));
export const credentials = async (orgId, id) => credentialsOf(await row(orgId, id));

export async function add(orgId, { provider, number, label, credentials: given }) {
  const p = PROVIDERS[provider];
  if (!p || !Object.hasOwn(PROVIDERS, provider)) throw new ValidationError(`unknown provider '${String(provider).slice(0, 30)}'`);
  number = normalizeNumber(number);
  const clean = Object.fromEntries(p.fields.map(([f]) => [f, String(given?.[f] ?? "").trim().slice(0, 500)]));
  const missing = p.fields.filter(([f]) => !clean[f]).map(([, l]) => l);
  if (missing.length) throw new ValidationError(`missing: ${missing.join(", ")}`);
  await ensureSeeded(orgId);
  // A number belongs to one organization, since inbound calls on it are routed by it.
  const owner = (await asSystem((db) => db.query("SELECT org_id FROM phone_numbers WHERE number = $1", [number]))).rows[0];
  if (owner) throw new ValidationError(owner.org_id === orgId ? `${number} is already added` : `${number} is already in use`);
  try {
    return await inOrg(orgId, async (db) => {
      const first = !(await db.query("SELECT 1 FROM phone_numbers WHERE org_id = $1 LIMIT 1", [orgId])).rowCount;
      const { rows } = await db.query(`INSERT INTO phone_numbers (id, provider, number, label, credentials_enc, is_default, org_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [hexId(), provider, number, String(label ?? "").trim().slice(0, 80), encryptJson(clean), first, orgId]);
      return toPublic(rows[0]);
    });
  } catch (err) {
    if (err.code === "23505") throw new ValidationError(`${number} is already in use`);
    throw err;
  }
}

/** A blank field keeps what is there, so a masked secret is never overwritten. */
export async function update(orgId, id, { label, credentials: given }) {
  return inOrg(orgId, async (db) => {
    const { rows } = await db.query("SELECT * FROM phone_numbers WHERE id = $1 AND org_id = $2 FOR UPDATE", [String(id ?? ""), orgId]);
    const current = rows[0];
    if (!current) throw new NotFoundError("number");
    let stored;
    try { stored = decryptJson(current.credentials_enc); } catch { stored = {}; }
    let changed = false;
    for (const [f] of PROVIDERS[current.provider].fields) {
      const value = String(given?.[f] ?? "").trim().slice(0, 500);
      if (value) { stored[f] = value; changed = true; }
    }
    const { rows: [next] } = await db.query(`UPDATE phone_numbers SET label = $1, credentials_enc = $2, updated_at = now()
      WHERE id = $3 AND org_id = $4 RETURNING *`, [typeof label === "string" ? label.trim().slice(0, 80) : current.label,
      changed ? encryptJson(stored) : current.credentials_enc, current.id, orgId]);
    return toPublic(next);
  });
}

export async function remove(orgId, id) {
  return inOrg(orgId, async (db) => {
    const { rows } = await db.query("DELETE FROM phone_numbers WHERE id = $1 AND org_id = $2 RETURNING *", [String(id ?? ""), orgId]);
    if (!rows[0]) throw new NotFoundError("number");
    if (rows[0].is_default) {
      await db.query(`UPDATE phone_numbers SET is_default = true WHERE id = (SELECT id FROM phone_numbers WHERE org_id = $1
        ORDER BY created_at, id LIMIT 1)`, [orgId]);
    }
    await db.query("DELETE FROM routes WHERE number = $1 AND org_id = $2", [rows[0].number, orgId]);
    return rows[0];
  });
}

export async function setDefault(orgId, id) {
  await row(orgId, id);
  return inOrg(orgId, async (db) => {
    await db.query("UPDATE phone_numbers SET is_default = false WHERE is_default AND org_id = $1 AND id <> $2", [orgId, id]);
    await db.query("UPDATE phone_numbers SET is_default = true WHERE id = $1 AND org_id = $2", [id, orgId]);
    return toPublic((await db.query("SELECT * FROM phone_numbers WHERE id = $1 AND org_id = $2", [id, orgId])).rows[0]);
  });
}

/** [auth_id, auth_token] of this organization's default active Plivo number, or nulls. Never throws.
 * Another organization's credentials, or the server's own, are never used. */
export async function plivoCredentials(orgId) {
  const none = [null, null];
  try {
    const rows = (await listPublic(orgId)).filter((r) => r.provider === "plivo" && r.status === "active");
    if (!rows.length) return none;
    const pick = rows.find((r) => r.is_default) || rows[0];
    const c = await credentials(orgId, pick.id);
    return [c.auth_id, c.auth_token];
  } catch (err) {
    logger.error({ err: err.message }, "numbers unreadable; Plivo is treated as not connected");
    return none;
  }
}

/** The organization that owns one of our numbers, or null. Never throws. */
export async function orgForNumber(raw) {
  try {
    const { rows } = await asSystem((db) => db.query("SELECT org_id FROM phone_numbers WHERE number = $1", [normalizeNumber(raw)]));
    return rows[0]?.org_id ?? null;
  } catch {
    return null;
  }
}
