// Connection pools. Every query has a deadline: a slow or stuck database answers
// with an error, never with a request that hangs forever.
//
// Tenant isolation: customer data is only reachable inside inOrg(orgId, ...),
// which sets app.org_id for that transaction, so row-level security (see
// migrations/002) shows that organization's rows and nothing else. asSystem()
// is for the few paths that work across organizations (sign-in, the voice
// service, imports). A plain query sees no customer rows at all.
import pg from "pg";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { connectionOptions } from "./ssl.js";

pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric -> number

const common = {
  ...connectionOptions(config.DATABASE_URL, config),
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  query_timeout: config.DB_STATEMENT_TIMEOUT_MS + 1000,
};

if (common.ssl && !common.ssl.rejectUnauthorized) {
  logger.warn("The database connection is encrypted but its certificate is not checked; set DATABASE_SSL_CA");
}

export const pool = new pg.Pool({ ...common, max: config.PGPOOL_MAX, application_name: "kaho-studio" });
pool.on("error", (err) => logger.error({ err: err.message }, "idle database client failed"));

// Every scoped transaction drops to the restricted role for its own duration
// (SET LOCAL resets at COMMIT/ROLLBACK), so row-level security applies even when
// the login happens to be a privileged user. In production DATABASE_URL should
// point at the restricted role directly and this is simply a no-op belt.
const ROLE_SQL = config.DB_APP_ROLE ? `SET LOCAL ROLE ${config.DB_APP_ROLE}` : null;

/** The owner's connection, for migrations only. */
export const ownerPool = () => new pg.Pool({ ...common, max: 2, application_name: "kaho-studio-migrate" });

async function scoped(setting, value, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (ROLE_SQL) await client.query(ROLE_SQL);
    await client.query("SELECT set_config($1, $2, true)", [setting, value]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const ORG_ID = /^org_[0-9a-f]{12}$/;

/** fn(db) in one transaction that can see only this organization's rows. */
export function inOrg(orgId, fn) {
  if (typeof orgId !== "string" || !ORG_ID.test(orgId)) throw new Error("inOrg needs an organization id");
  return scoped("app.org_id", orgId, fn);
}
export const orgQuery = (orgId, text, params) => inOrg(orgId, (db) => db.query(text, params));

/** fn(db) in one transaction across organizations. Sign-in, the voice service and imports only. */
export const asSystem = (fn) => scoped("app.bypass", "on", fn);
export const systemQuery = (text, params) => asSystem((db) => db.query(text, params));
