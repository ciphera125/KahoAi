// Request limits, in layers:
//  - ipLimiter: a high flood ceiling per address, so one machine cannot bury
//    the server, but a whole office behind one address is nowhere near it.
//  - sessionLimiter: the everyday limit, keyed by the session (each signed-in
//    browser), so many colleagues behind one office address are counted apart.
//    Signed out, it falls back to the address.
//  - authLimiter: per address on sign-in and sign-up, against guessing.
// With REDIS_URL the counts are shared by every process and server. If Redis
// fails, counting carries on in this process's memory, so limits never switch
// off; the sign-in lockout itself lives in PostgreSQL regardless.
import { ipKeyGenerator, MemoryStore, rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import { createHash } from "node:crypto";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

let redis = null;
if (config.REDIS_URL) {
  redis = createClient({ url: config.REDIS_URL, socket: { connectTimeout: 2000, reconnectStrategy: (n) => Math.min(n * 200, 5000) } });
  redis.on("error", (err) => logger.warn({ err: err.message }, "redis unavailable; rate limits count in memory"));
  redis.connect().catch(() => {});
}

const memoryStores = [];
function store(prefix) {
  if (redis) return new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (...args) => redis.sendCommand(args) });
  const memory = new MemoryStore();
  memoryStores.push(memory);
  return memory;
}

const common = {
  windowMs: 60_000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  passOnStoreError: true,
  handler: (_req, res) => res.status(429).json({ error: "too many requests; slow down and try again shortly" }),
};

// The session cookie value, if the browser sent one; identifies the browser
// before the session is looked up. Falls back to the (IPv6-safe) address.
function sessionKey(req) {
  const raw = req.headers.cookie || "";
  const match = raw.match(/(?:^|;\s*)kaho_session=([^;]+)/);
  if (match) return `s:${createHash("sha256").update(match[1]).digest("hex").slice(0, 32)}`;
  return `ip:${ipKeyGenerator(req.ip)}`;
}

// The admin site counts its own: sign-in per address, everything else per admin session.
function cookieKey(name) {
  return (req) => {
    const match = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match ? `s:${createHash("sha256").update(match[1]).digest("hex").slice(0, 32)}` : `ip:${ipKeyGenerator(req.ip)}`;
  };
}

export const ipLimiter = rateLimit({ ...common, limit: config.IP_RATE_LIMIT_PER_MIN,
  keyGenerator: (req) => ipKeyGenerator(req.ip), store: store("ip") });
export const sessionLimiter = rateLimit({ ...common, limit: config.API_RATE_LIMIT_PER_MIN,
  keyGenerator: sessionKey, store: store("api") });
export const adminAuthLimiter = rateLimit({ ...common, limit: config.ADMIN_AUTH_RATE_LIMIT_PER_MIN, keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip)}`,
  store: store("admin-auth") });
export const adminLimiter = rateLimit({ ...common, limit: config.ADMIN_RATE_LIMIT_PER_MIN, keyGenerator: cookieKey("kaho_admin"), store: store("admin-api") });
export const authLimiter = rateLimit({ ...common, limit: config.AUTH_RATE_LIMIT_PER_MIN, store: store("auth") });

// Guessing invite codes: counted per signed-in person, not per address, so one person guessing
// cannot lock sign-up and sign-in for a whole office, and a colleague is not blocked by them.
export const joinLimiter = rateLimit({ ...common, limit: config.AUTH_RATE_LIMIT_PER_MIN,
  keyGenerator: (req) => `u:${req.user?.id ?? ipKeyGenerator(req.ip)}`, store: store("join") });

// Placing calls through the API costs real money and rings real people, so it has its own, much
// lower limits than reading: per organization, a short burst limit and a daily ceiling.
const callsRefused = (_req, res) => res.status(429).json({
  error: "too many calls placed through the API; wait a moment, or ask an admin to place them in bulk from the Studio" });
export const apiCallsPerMinute = rateLimit({ ...common, limit: config.API_CALLS_PER_MIN, handler: callsRefused,
  keyGenerator: (req) => `o:${req.apiOrgId}`, store: store("apicalls-min") });
export const apiCallsPerDay = rateLimit({ ...common, windowMs: 86_400_000, limit: config.API_CALLS_PER_DAY, handler: callsRefused,
  keyGenerator: (req) => `o:${req.apiOrgId}`, store: store("apicalls-day") });

const builderRefused = (_req, res) => res.status(429).json({
  error: "Too many messages to Kaho Builder in a short while. Please wait a moment and try again." });
export const assistantPerMinute = rateLimit({ ...common, limit: config.ASSISTANT_PER_MIN, handler: builderRefused,
  keyGenerator: (req) => `o:${req.user?.org_id ?? "none"}`, store: store("builder-min") });
export const assistantPerDay = rateLimit({ ...common, windowMs: 86_400_000, limit: config.ASSISTANT_PER_DAY, handler: builderRefused,
  keyGenerator: (req) => `o:${req.user?.org_id ?? "none"}`, store: store("builder-day") });

const costlyRefused = (what) => (_req, res) => res.status(429).json({
  error: `${what} was just run a few times. Please wait a minute and try again.` });
const perOrg = (req) => `o:${req.user?.org_id ?? `ip:${ipKeyGenerator(req.ip)}`}`;
export const archiveRunPerMinute = rateLimit({ ...common, limit: config.ARCHIVE_RUN_PER_MIN, handler: costlyRefused("Filing records"),
  keyGenerator: perOrg, store: store("archive-run") });
export const healthPerMinute = rateLimit({ ...common, limit: config.HEALTH_PER_MIN, handler: costlyRefused("The system check"),
  keyGenerator: perOrg, store: store("health") });

// Choosing a plan, asking for a top-up, withdrawing one: per organization, an hour at a time, so a stuck
// button or a script cannot fill the admins' queue.
const billingRefused = (_req, res) => res.status(429).json({ error: "Too many billing requests in the last hour. Please wait and try again." });
export const billingWritesPerHour = rateLimit({ ...common, windowMs: 3_600_000, limit: config.BILLING_WRITES_PER_HOUR, handler: billingRefused,
  keyGenerator: perOrg, store: store("billing-writes") });

/** Forget every count (tests). */
export const resetRateLimits = () => Promise.all(memoryStores.map((m) => m.resetAll()));
export const closeRedis = () => redis?.quit().catch(() => {});
