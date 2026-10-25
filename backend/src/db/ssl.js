// How to connect to the database: TLS for a managed one (Supabase), none locally.
//
// sslmode in DATABASE_URL is taken out and decided here instead: node-postgres
// reads sslmode=require as "verify the certificate", which fails against
// Supabase's own CA unless it is given, and the choice should be explicit.
// - DATABASE_SSL=off|require|verify forces a mode; otherwise Supabase hosts
//   get TLS and local ones do not.
// - DATABASE_SSL_CA (the PEM text, or a path to it) verifies the server: Supabase
//   offers its certificate under Project Settings > Database > SSL.
// - The transaction pooler (port 6543) is refused: transactions there share
//   sessions, which breaks the advisory locks (migrations, the bulk runner) and
//   LISTEN (live transcripts). Use the session pooler or a direct connection (5432).
import { readFileSync } from "node:fs";

const MANAGED = /\.supabase\.(co|com)$/i;

function readCa(raw) {
  if (!raw) return null;
  const text = raw.includes("-----BEGIN") ? raw : readFileSync(raw, "utf8");
  return text.replace(/\\n/g, "\n");
}

export function connectionOptions(databaseUrl, env = process.env) {
  let url;
  try { url = new URL(databaseUrl); } catch { return { connectionString: databaseUrl, ssl: false }; }
  const managed = MANAGED.test(url.hostname);
  if (managed && url.port === "6543") {
    throw new Error("DATABASE_URL points at Supabase's transaction pooler (port 6543). Use the session pooler "
      + "or the direct connection (port 5432): migrations, the bulk runner and live transcripts need a real session.");
  }
  url.searchParams.delete("sslmode");
  const connectionString = url.search ? url.toString() : url.toString().replace(/\?$/, "");
  const mode = (env.DATABASE_SSL || (managed ? "auto" : "off")).toLowerCase();
  const ca = readCa(env.DATABASE_SSL_CA);
  if (mode === "off" || mode === "false") return { connectionString, ssl: false };
  if (mode === "verify" && !ca) throw new Error("DATABASE_SSL=verify needs DATABASE_SSL_CA (the server's CA certificate)");
  if (ca && mode !== "require") return { connectionString, ssl: { rejectUnauthorized: true, ca } };
  return { connectionString, ssl: { rejectUnauthorized: false } };
}
