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
  PUBLIC_HOST: z.string().optional(),
  PUBLIC_SCHEME: z.enum(["https", "http"]).default("https"),
  WEBHOOK_SECRET: z.string().optional(),
  MAX_CALL_DURATION_SECS: z.string().optional(),
  PLIVO_API_BASE: z.url().default("https://api.plivo.com"),
  PLIVO_DIAL_TIMEOUT_MS: int(15000, 1000, 60000),
  PREFLIGHT_TIMEOUT_MS: int(10000, 1000, 60000),
  STREAM_WAIT_SECS: int(90, 1, 600),
  STREAM_MAX_SECS: int(3600, 10, 86400),
  MAX_STREAMS_PER_USER: int(5, 1, 100),
  PLIVO_FROM_NUMBER: z.string().optional(),
  PLIVO_AUTH_ID: z.string().optional(),
  PLIVO_AUTH_TOKEN: z.string().optional(),
  TRANSFER_NUMBER: z.string().optional(),
  TOOL_WEBHOOK_URL: z.string().optional(),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Bad configuration:\n${lines.join("\n")}`);
  }
  const env = parsed.data;
  const production = env.NODE_ENV === "production";
  if (production && env.PUBLIC_SCHEME !== "https") throw new Error("Bad configuration:\n  PUBLIC_SCHEME must be https in production");
  const origins = list(env.ALLOWED_ORIGINS);
  const hosts = env.ALLOWED_HOSTS ? list(env.ALLOWED_HOSTS)
    : [`localhost:${env.PORT}`, `127.0.0.1:${env.PORT}`, ...origins.map((o) => new URL(o).host)];
  return {
    ...env,
    production,
    origins,
    hosts,
    trustProxy: bool(false).parse(env.TRUST_PROXY),
    cookieSecure: bool(production).parse(env.COOKIE_SECURE),
  };
}

export const config = load();
