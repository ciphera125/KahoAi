// Leads the voice service's capture_lead tool saved, mirrored here so the
// Studio has them too (the voice service still keeps its own local copy).
import { asSystem, inOrg } from "../db/pool.js";
import { ValidationError } from "../utils/errors.js";

const PHONE_SOURCES = new Set(["caller_stated", "call_metadata"]);
const MAX_TEXT = 500;
const MAX_PHONE = 32;

export async function add(orgId, { call_id, name, phone, phone_source, reason }) {
  const n = String(name ?? "").slice(0, MAX_TEXT);
  if (!n) throw new ValidationError("name is required");
  const p = String(phone ?? "").slice(0, MAX_PHONE);
  if (!p) throw new ValidationError("phone is required");
  const r = String(reason ?? "").slice(0, MAX_TEXT);
  if (!r) throw new ValidationError("reason is required");
  const src = PHONE_SOURCES.has(phone_source) ? phone_source : "call_metadata";
  await asSystem((db) => db.query(
    "INSERT INTO leads (org_id, call_id, name, phone, phone_source, reason) VALUES ($1, $2, $3, $4, $5, $6)",
    [orgId, call_id || null, n, p, src, r]));
}

export async function list(orgId, { limit = 50 } = {}) {
  const n = Math.min(Math.max(1, Number(limit) || 50), 200);
  const { rows } = await inOrg(orgId, (db) => db.query(
    "SELECT id, call_id, name, phone, phone_source, reason, at FROM leads WHERE org_id = $1 ORDER BY at DESC LIMIT $2",
    [orgId, n]));
  return { leads: rows.map((r) => ({ ...r, id: Number(r.id), at: r.at.toISOString() })) };
}
