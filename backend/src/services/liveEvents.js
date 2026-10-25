// New transcript lines, announced across every server process with PostgreSQL
// LISTEN/NOTIFY: one listening connection per process, fanned out in memory to
// the live-transcript streams that process holds.
import { EventEmitter } from "node:events";
import pg from "pg";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

const bus = new EventEmitter();
bus.setMaxListeners(0);
let client = null;
let connecting = null;
let stopped = false;

async function connect() {
  const c = new pg.Client({ connectionString: config.DATABASE_URL, application_name: "kaho-studio-listen" });
  c.on("notification", (msg) => bus.emit(msg.payload));
  c.on("error", (err) => {
    logger.warn({ err: err.message }, "live events connection lost; reconnecting");
    client = null;
    if (!stopped) setTimeout(() => ensureListening().catch(() => {}), 1000).unref();
  });
  await c.connect();
  await c.query("LISTEN call_events");
  client = c;
}

export function ensureListening() {
  if (client || stopped) return Promise.resolve();
  connecting ||= connect().finally(() => { connecting = null; });
  return connecting;
}

/** fn() runs whenever new lines arrive for callId. Returns the unsubscribe. */
export function subscribe(callId, fn) {
  ensureListening().catch((err) => logger.warn({ err: err.message }, "live events unavailable; streams poll instead"));
  bus.on(callId, fn);
  return () => bus.off(callId, fn);
}

export async function stopListening() {
  stopped = true;
  await client?.end().catch(() => {});
  client = null;
}
