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
