// The Express app: middleware in the order a request meets it, then the routes.
// No listen() here, so tests drive it directly and server.js decides how to run it.
import express from "express";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";
import { config } from "./config/env.js";
import { pool } from "./db/pool.js";
import { logger } from "./utils/logger.js";
import { apiHeaders, hostCheck, jsonOnly, originCheck } from "./middleware/security.js";
import { ipLimiter, sessionLimiter } from "./middleware/rateLimit.js";
import { requireServiceToken } from "./middleware/internal.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import apiRouter from "./routes/index.js";
import internalRouter from "./routes/internal.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy ? 1 : false);
  app.use(pinoHttp({ logger, genReqId: (req) => req.headers["x-request-id"]?.slice(0, 64) || randomUUID(),
    autoLogging: config.NODE_ENV !== "test" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/readyz", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  app.use("/api", apiHeaders, hostCheck, originCheck, ipLimiter, sessionLimiter, jsonOnly,
    express.json({ limit: "64kb" }), cookieParser(), apiRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

/** The voice service's API, on its own port (INTERNAL_PORT, 127.0.0.1 by
 * default), so it is never reachable through the public one. */
export function createInternalApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(pinoHttp({ logger, autoLogging: config.NODE_ENV !== "test" }));
  app.use("/internal/v1", requireServiceToken, express.json({ limit: "512kb" }), internalRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
