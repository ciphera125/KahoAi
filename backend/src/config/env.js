// Every setting the API reads, checked once at start-up. A missing or malformed
// value stops the process with a clear message instead of failing on a request.
import dotenv from "dotenv";
import { z } from "zod";

// Tests set their own settings and must never read a developer's .env.
if (process.env.NODE_ENV !== "test") dotenv.config({ quiet: true });

const list = (raw) => (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
const bool = (fallback) => z.string().optional().transform((v) => (v === undefined || v === "" ? fallback : /^(1|true|yes)$/i.test(v)));
const int = (fallback, min, max) => z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(8020, 1, 65535),
  INTERNAL_HOST: z.string().default("127.0.0.1"),
  INTERNAL_PORT: int(8021, 1, 65535),
  WEB_CONCURRENCY: int(1, 1, 64),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (postgres://...)"),
  DATABASE_SSL: z.enum(["", "off", "require", "verify"]).optional(),
  DATABASE_SSL_CA: z.string().optional(),
  PGPOOL_MAX: int(10, 1, 200),
  DB_APP_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).or(z.literal("")).default("kaho_app"),
  DB_STATEMENT_TIMEOUT_MS: int(5000, 100, 120000),
  ALLOWED_ORIGINS: z.string().min(1, "ALLOWED_ORIGINS is required, e.g. http://localhost:5173"),
  ALLOWED_HOSTS: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  COOKIE_SECURE: z.string().optional(),
  SECRETS_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "SECRETS_KEY must be 64 hex characters (openssl rand -hex 32)"),
  INTERNAL_API_TOKEN: z.string().min(32, "INTERNAL_API_TOKEN must be at least 32 characters"),
  REDIS_URL: z.string().optional(),
  API_RATE_LIMIT_PER_MIN: int(600, 1, 1_000_000),
  IP_RATE_LIMIT_PER_MIN: int(6000, 1, 10_000_000),
  AUTH_RATE_LIMIT_PER_MIN: int(20, 1, 10_000),
  // Calls placed through the public API, per organization (not per key: keys are free to make).
  // Kaho Builder costs model tokens: per organization, a short burst limit and a daily ceiling.
  ASSISTANT_PER_MIN: int(15, 1, 1000),
  ASSISTANT_PER_DAY: int(300, 1, 10000),
  API_CALLS_PER_MIN: int(10, 1, 1000),
  API_CALLS_PER_DAY: int(500, 1, 2000),
  // Admin actions that cost real work (filing records in Storage, five outside checks), per organization.
  ARCHIVE_RUN_PER_MIN: int(3, 1, 100),
  HEALTH_PER_MIN: int(12, 1, 600),
  CALENDLY_CONNECT_PER_MIN: int(5, 1, 60),   // pasting a token: each try asks Calendly, so it must not be a way to test stolen tokens
  CALENDLY_LOOKUP_PER_MIN: int(10, 1, 120),  // the meeting-type list: each look-up asks Calendly
  PUBLIC_HOST: z.string().optional(),
  PUBLIC_SCHEME: z.enum(["https", "http"]).default("https"),
  WEBHOOK_SECRET: z.string().optional(),
  MAX_CALL_DURATION_SECS: z.string().optional(),
  PLIVO_API_BASE: z.url().default("https://api.plivo.com"),
  CALENDLY_API_BASE: z.url().default("https://api.calendly.com"), // tests only: production always uses the real one
  PLIVO_DIAL_TIMEOUT_MS: int(15000, 1000, 60000),
  PREFLIGHT_TIMEOUT_MS: int(10000, 1000, 60000),
  STREAM_WAIT_SECS: int(90, 1, 600),
  STREAM_MAX_SECS: int(3600, 10, 86400),
  MAX_STREAMS_PER_USER: int(5, 1, 100),
  BULK_MAX_CONCURRENT: int(10, 1, 100),   // the voice server's WS_MAX_CONCURRENT_CALLS
  BULK_OUTSIDE_CAP: int(6, 1, 100),      // most slots one organization's hand-placed and inbound calls can take from bulk calls
  BULK_TICK_MS: int(2000, 200, 60000),
  BULK_FAIL_STREAK: int(3, 2, 50),        // this many refused dials in a row pause a bulk call
  PLIVO_SYNC_INTERVAL_MS: int(180000, 30000, 3600000), // how often the Dashboard reconciles outcomes with Plivo on its own
  BULK_REPEAT_HOURS: int(24, 0, 720),     // nobody is called again by a bulk call within this; 0 turns it off
  PLIVO_FROM_NUMBER: z.string().optional(),
  PLIVO_AUTH_ID: z.string().optional(),
  PLIVO_AUTH_TOKEN: z.string().optional(),
  TRANSFER_NUMBER: z.string().optional(),
  TOOL_WEBHOOK_URL: z.string().optional(),
  SUPABASE_URL: z.url().or(z.literal("")).optional(),            // call recordings: signed links to the private Storage bucket
  SUPABASE_SECRET_KEY: z.string().optional(),
  SUPABASE_RECORDINGS_BUCKET: z.string().optional(),          // the customers' bucket: recordings, transcripts and each organization's records
  SUPABASE_ADMIN_BUCKET: z.string().optional(),               // Kaho staff's own records, a separate bucket from the customers'
  RECORDING_RETENTION_DAYS: z.coerce.number().positive().default(60), // cloud copies are deleted after this many days
  RECORDING_RETENTION_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  ARCHIVE_INTERVAL_MS: z.coerce.number().int().positive().default(300_000), // audit, tool, Builder and call records filed in Storage
  // "Test this agent": a short simulated conversation with the draft. Optional, and kept
  // separate from the voice service's key so the Studio's own use of it is visible.
  GROQ_API_KEY: z.string().optional(),
  GROQ_API_BASE: z.url().default("https://api.groq.com"),
  HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  GROQ_MODEL_ID: z.string().default("openai/gpt-oss-20b"),
  // Publish needs a passing test of the same draft. An admin can still publish over it.
  REQUIRE_AGENT_TEST: bool(true),
  // Billing. Off only for tests and local trials: with it off no organization is ever locked or metered.
  BILLING_ENFORCED: bool(true),
  BILLING_WRITES_PER_HOUR: int(60, 1, 10000),
  BILLING_INTERVAL_MS: int(3_600_000, 1000, 86_400_000), // how often plans are checked for the end of their month
  // A new organization starts its plan at once, without an admin confirming payment. Off by default: a plan
  // is active only when Kaho has been paid (or an admin says so).
  SUBSCRIPTION_AUTO_ACTIVATE: bool(false),
  BILLING_PAYMENT_INSTRUCTIONS: z.string().max(600).optional(),  // shown with a plan or top-up request: how to pay
  STUDIO_URL: z.url().optional(),                                 // where "open as this person" lands; defaults to the first allowed origin
  // The admin site: its own origin(s), accounts and cookie. Only these e-mails may ever have an admin account,
  // and a new one needs ADMIN_SIGNUP_CODE as well (an e-mail address is not proof of who is typing it).
  ADMIN_EMAILS: z.string().default("adityanair5002@gmail.com,aayushimakker10@gmail.com"),
  ADMIN_ORIGINS: z.string().default("http://localhost:5174"),
  ADMIN_SIGNUP_CODE: z.string().min(16, "ADMIN_SIGNUP_CODE must be at least 16 characters").optional().or(z.literal("")),
  ADMIN_AUTH_RATE_LIMIT_PER_MIN: int(10, 1, 1000),
  ADMIN_RATE_LIMIT_PER_MIN: int(300, 1, 100000),
});

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why these admin-site addresses may not be used, or null. In production they must be https, except on this
 * machine itself (localhost, 127.0.0.1, [::1]): the Studio is served that way in production mode too, and the hostname is
 * read by the URL parser, so "localhost.evil.com" and "localhost@evil.com" are not mistaken for it.
 */
export function adminOriginsProblem(origins, production) {
  if (!production) return null;
  for (const raw of origins) {
    let url;
    try { url = new URL(raw); } catch { return `ADMIN_ORIGINS has '${String(raw).slice(0, 60)}', which is not an address`; }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname) && !url.username && !url.password)) {
      return "ADMIN_ORIGINS must be https addresses in production (plain http is only allowed on this machine)";
    }
  }
  return null;
}

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Bad configuration:\n${lines.join("\n")}`);
  }
  const env = parsed.data;
  const production = env.NODE_ENV === "production";
  if (production && env.PUBLIC_SCHEME !== "https") throw new Error("Bad configuration:\n  PUBLIC_SCHEME must be https in production");
  const adminProblem = adminOriginsProblem(list(env.ADMIN_ORIGINS), production);
  if (adminProblem) throw new Error(`Bad configuration:\n  ${adminProblem}`);
  const origins = list(env.ALLOWED_ORIGINS);
  const hosts = env.ALLOWED_HOSTS ? list(env.ALLOWED_HOSTS)
    : [`localhost:${env.PORT}`, `127.0.0.1:${env.PORT}`, ...origins.map((o) => new URL(o).host)];
  return {
    ...env,
    production,
    origins,
    hosts,
    adminEmails: list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
    adminOrigins: list(env.ADMIN_ORIGINS),
    adminHosts: [...new Set([...(env.ALLOWED_HOSTS ? list(env.ALLOWED_HOSTS) : [`localhost:${env.PORT}`, `127.0.0.1:${env.PORT}`]),
      ...list(env.ADMIN_ORIGINS).map((o) => new URL(o).host)])],
    studioUrl: env.STUDIO_URL ?? origins[0],
    trustProxy: bool(false).parse(env.TRUST_PROXY),
    cookieSecure: bool(production).parse(env.COOKIE_SECURE),
  };
}

export const config = load();
