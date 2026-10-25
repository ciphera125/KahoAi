// Connecting to a managed database (Supabase) over TLS.
import { describe, expect, it } from "vitest";
import { connectionOptions } from "../src/db/ssl.js";

const SUPA = "postgresql://postgres.abcd:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres";
const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

describe("database TLS", () => {
  it("a local database needs none", () => {
    expect(connectionOptions("postgres:///kaho_studio", {})).toEqual({ connectionString: "postgres:///kaho_studio", ssl: false });
  });

  it("Supabase is encrypted by default, even without sslmode in the URL", () => {
    const o = connectionOptions(SUPA, {});
    expect(o.ssl).toBeTruthy();
    expect(o.connectionString).toBe(SUPA);
  });

  it("with Supabase's CA certificate the server is verified, not just encrypted", () => {
    expect(connectionOptions(SUPA, { DATABASE_SSL_CA: CA }).ssl).toEqual({ rejectUnauthorized: true, ca: CA });
  });

  it("without the CA it encrypts but cannot verify, and says so", () => {
    expect(connectionOptions(SUPA, {}).ssl).toEqual({ rejectUnauthorized: false });
  });

  it("sslmode in the URL is taken out, so it cannot override the choice above", () => {
    const o = connectionOptions(`${SUPA}?sslmode=require`, { DATABASE_SSL_CA: CA });
    expect(o.connectionString).toBe(SUPA);
    expect(o.ssl).toEqual({ rejectUnauthorized: true, ca: CA });
  });

  it("DATABASE_SSL forces it on or off for any host", () => {
    expect(connectionOptions("postgres://db.internal/x", { DATABASE_SSL: "require" }).ssl).toEqual({ rejectUnauthorized: false });
    expect(connectionOptions(SUPA, { DATABASE_SSL: "off" }).ssl).toBe(false);
    expect(connectionOptions("postgres://db.internal/x", { DATABASE_SSL: "verify", DATABASE_SSL_CA: CA }).ssl)
      .toEqual({ rejectUnauthorized: true, ca: CA });
  });

  it("verify without a CA is refused, rather than quietly not verifying", () => {
    expect(() => connectionOptions(SUPA, { DATABASE_SSL: "verify" })).toThrow(/DATABASE_SSL_CA/);
  });

  it("the Supabase transaction pooler (port 6543) is refused: sessions, locks and LISTEN need a session", () => {
    expect(() => connectionOptions("postgresql://p:x@aws-0-ap-south-1.pooler.supabase.com:6543/postgres", {}))
      .toThrow(/5432/);
  });
});
