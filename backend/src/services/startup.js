// Checks run before the server takes traffic. Each turns a silent failure into
// a refusal to start with a plain reason.
import net from "node:net";
import { config } from "../config/env.js";
import { asSystem, pool } from "../db/pool.js";
import { decryptJson, encryptJson } from "../utils/crypto.js";

/** Something already answering on host:port (another app bound to 127.0.0.1
 * can take traffic meant for us without any error). */
export function portTaken(port, hosts = ["127.0.0.1", "::1"]) {
  return Promise.all(hosts.map((host) => new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (taken) => { socket.destroy(); resolve(taken); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  }))).then((answers) => answers.some(Boolean));
}

/** SECRETS_KEY must be the key the stored credentials were encrypted with; a
 * new or lost key would make every saved provider token unreadable. */
export async function checkSecretsKey() {
  await asSystem(async (db) => {
    const { rows } = await db.query("SELECT value FROM meta WHERE key = 'secrets_canary'");
    if (!rows[0]) {
      await db.query("INSERT INTO meta (key, value) VALUES ('secrets_canary', $1) ON CONFLICT DO NOTHING", [encryptJson("kaho")]);
      return;
    }
    let ok;
    try { ok = decryptJson(rows[0].value) === "kaho"; } catch { ok = false; }
    if (!ok) {
      throw new Error("SECRETS_KEY is not the key the stored credentials were encrypted with. "
        + "Restore the original key; starting would make every saved provider token unreadable.");
    }
  });
}

/** A scoped transaction must run as the restricted role and have row-level
 * security on, or one team could read another's rows. Checked for real: in a
 * transaction we drop to the role and confirm RLS is not being bypassed. */
export async function checkDatabaseRole() {
  if (!config.DB_APP_ROLE) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${config.DB_APP_ROLE}`);
    const { rows } = await client.query(
      "SELECT current_user AS u, (SELECT bool_and(rowsecurity) FROM pg_tables WHERE tablename = 'contacts') AS rls");
    await client.query("ROLLBACK");
    if (rows[0].u !== config.DB_APP_ROLE) {
      throw new Error(`a scoped transaction runs as ${rows[0].u}, not ${config.DB_APP_ROLE}: tenant isolation would not be enforced`);
    }
    if (rows[0].rls === false) throw new Error("row-level security is off on the data tables: tenant isolation would not be enforced");
  } finally {
    client.release();
  }
}

/** Whether the connections this Studio may open fit in what the database has left. Pure, so it is easy to test.
 * Each worker can hold `perWorker` for requests and one more for the bulk runner's lock; the first process and the
 * migrations use two more. More than 80% of what is left is a warning: other programs (the phone server's
 * own reads, a console, the pooler) need room too. */
export function connectionBudget({ perWorker, workers, serverMax, reserved = 3, usedByOthers = 0 }) {
  const need = workers * (perWorker + 1) + 2;
  if (!Number.isFinite(serverMax) || serverMax < 1) return { ok: true, skipped: true, need, available: null, message: "The database did not say how many connections it allows." };
  const available = serverMax - reserved - usedByOthers;
  const ok = need <= available * 0.8;
  const message = ok
    ? `Up to ${need} database connections, of ${available} the server has free.`
    : `This Studio can open up to ${need} database connections (${workers} worker${workers === 1 ? "" : "s"} x PGPOOL_MAX ${perWorker} + 1 each, + 2) `
      + `but the database has only ${available} free (${serverMax} allowed, ${reserved} kept back, ${usedByOthers} used by others). `
      + "Lower PGPOOL_MAX or WEB_CONCURRENCY, or raise the database's connection limit; a pooler such as Supabase's has its own, lower limit.";
  return { ok, need, available, message };
}

/** The budget against the real database. Never throws: a database that will not say is not a reason to stop. */
export async function checkConnectionBudget() {
  try {
    const { rows: [r] } = await pool.query(`SELECT current_setting('max_connections')::int AS max,
      current_setting('superuser_reserved_connections')::int AS reserved,
      (SELECT count(*)::int FROM pg_stat_activity WHERE application_name NOT LIKE 'kaho-studio%' AND datname = current_database()) AS others`);
    return connectionBudget({ perWorker: config.PGPOOL_MAX, workers: config.WEB_CONCURRENCY, serverMax: r.max, reserved: r.reserved, usedByOthers: r.others });
  } catch (err) {
    return { ok: true, skipped: true, message: `Could not read the database's connection limits (${String(err.message).slice(0, 80)}).` };
  }
}
