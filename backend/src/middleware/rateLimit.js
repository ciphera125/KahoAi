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

export const ipLimiter = rateLimit({ ...common, limit: config.IP_RATE_LIMIT_PER_MIN,
  keyGenerator: (req) => ipKeyGenerator(req.ip), store: store("ip") });
export const sessionLimiter = rateLimit({ ...common, limit: config.API_RATE_LIMIT_PER_MIN,
  keyGenerator: sessionKey, store: store("api") });
export const authLimiter = rateLimit({ ...common, limit: config.AUTH_RATE_LIMIT_PER_MIN, store: store("auth") });

/** Forget every count (tests). */
export const resetRateLimits = () => Promise.all(memoryStores.map((m) => m.resetAll()));
export const closeRedis = () => redis?.quit().catch(() => {});
