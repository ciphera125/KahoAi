// Runs the API: migrations once in the primary, then WEB_CONCURRENCY workers
// sharing the port. A worker that dies is replaced. SIGTERM/SIGINT stop taking
// new connections, let requests in flight finish (up to 10s), then close the pool.
import cluster from "node:cluster";
import { config } from "./config/env.js";
import { logger } from "./utils/logger.js";

async function primary() {
  const { migrate } = await import("./db/migrate.js");
  const { pool } = await import("./db/pool.js");
  const { checkDatabaseRole, checkSecretsKey, portTaken } = await import("./services/startup.js");
  for (const port of [config.PORT, config.INTERNAL_PORT]) {
    if (await portTaken(port)) throw new Error(`port ${port} is already answering on this machine; stop that program or set another port`);
  }
  const applied = await migrate();
  if (applied.length) logger.info({ applied }, "migrations applied");
  await checkDatabaseRole();
  await checkSecretsKey();
  await pool.end();
  for (let i = 0; i < config.WEB_CONCURRENCY; i++) cluster.fork();
  let stopping = false;
  cluster.on("exit", (worker, code) => {
    if (stopping) return;
    logger.error({ pid: worker.process.pid, code }, "worker died; starting another");
    setTimeout(() => cluster.fork(), 1000);
  });
  const stop = () => { stopping = true; for (const w of Object.values(cluster.workers)) w.process.kill("SIGTERM"); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  logger.info(`Kaho AI Studio API on http://${config.HOST}:${config.PORT}, voice service API on `
    + `http://${config.INTERNAL_HOST}:${config.INTERNAL_PORT} (${config.WEB_CONCURRENCY} worker(s))`);
}

async function worker() {
  const { createApp, createInternalApp } = await import("./app.js");
  const { pool } = await import("./db/pool.js");
  const { stopListening } = await import("./services/liveEvents.js");
  const { closeRedis } = await import("./middleware/rateLimit.js");
  const { startBulkRunner, stopBulkRunner } = await import("./services/bulkRunner.js");
  const server = createApp().listen(config.PORT, config.HOST);
  const internal = createInternalApp().listen(config.INTERNAL_PORT, config.INTERNAL_HOST);
  for (const s of [server, internal]) s.on("error", (err) => { logger.fatal({ err: err.message }, "could not listen"); process.exit(1); });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000; // live-transcript streams are exempt: they write continuously
  server.keepAliveTimeout = 5_000;
  startBulkRunner();
  const shutdown = async () => {
    stopBulkRunner();
    server.close();
    internal.close();
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 10_000).unref();
    await stopListening();
    await closeRedis();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

(cluster.isPrimary ? primary() : worker()).catch((err) => {
  logger.fatal({ err: err.message }, "could not start");
  process.exit(1);
});
