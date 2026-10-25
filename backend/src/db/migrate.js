// Applies db/migrations/*.sql in name order, each once, each in a transaction.
// An advisory lock keeps two servers starting together from racing.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ownerPool } from "./pool.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate() {
  const pool = ownerPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then((applied) => { console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date."); })
    .catch((err) => { console.error(err.message); process.exitCode = 1; });
}
