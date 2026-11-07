import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { db, freshDb, owner } from "./helpers.js";
import { migrate } from "../src/db/migrate.js";

const SQL = readFileSync(new URL("../src/db/migrations/008_supabase_hardening_and_recordings.sql", import.meta.url), "utf8");

// What Supabase gives every new table: full rights to its public-API roles.
async function asSupabaseDefaults() {
  await db.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated");
  await db.query("GRANT USAGE ON SCHEMA public TO anon, authenticated");
}
async function as(role, sql, { bypass = false } = {}) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${role}`);
    if (bypass) await c.query("SET LOCAL app.bypass = 'on'");
    return await c.query(sql);
  } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
}

beforeAll(async () => { await freshDb(); await owner(); });

describe("the public API roles can never read or write the Studio's tables", () => {
  it.each(["anon", "authenticated"])("%s: the migration takes the Supabase default grants away", async (role) => {
    await asSupabaseDefaults();
    await db.query(SQL); // the migration is safe to run again
    for (const t of ["users", "sessions", "contacts", "calls", "call_events", "schema_migrations"]) {
      const r = await db.query("SELECT has_table_privilege($1, $2, 'SELECT') AS s", [role, t]);
      expect(r.rows[0].s, `${role} on ${t}`).toBe(false);
    }
  });

  it.each(["anon", "authenticated"])("%s: even with every grant back and app.bypass on, a restrictive policy shows nothing", async (role) => {
    await asSupabaseDefaults(); // a later table or a dashboard click can hand grants out again
    for (const bypass of [false, true]) {
      for (const t of ["users", "sessions", "contacts", "calls"]) {
        const r = await as(role, `SELECT count(*)::int AS n FROM ${t}`, { bypass });
        expect(r.rows[0].n, `${role} ${t} bypass=${bypass}`).toBe(0);
      }
      await expect(as(role, "UPDATE users SET name = 'pwned'", { bypass })).resolves.toMatchObject({ rowCount: 0 });
      await expect(as(role, "INSERT INTO organizations (id, name) VALUES ('org_evil', 'x')", { bypass })).rejects.toThrow(/row-level security/);
    }
  });

  it("schema_migrations is row-protected and the runner still works", async () => {
    const c = (await db.query("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname = 'schema_migrations'")).rows[0];
    expect(c).toEqual({ r: true, f: true });
    await asSupabaseDefaults();
    await expect(as("anon", "INSERT INTO schema_migrations (name) VALUES ('999_evil.sql')", { bypass: true })).rejects.toThrow();
    expect(await migrate()).toEqual([]);
  });

  it("the app role gets an idle-transaction timeout", async () => {
    const r = await db.query("SELECT rolconfig FROM pg_roles WHERE rolname = 'kaho_app'");
    expect(r.rows[0].rolconfig.join()).toMatch(/idle_in_transaction_session_timeout=15s/);
  });
});
