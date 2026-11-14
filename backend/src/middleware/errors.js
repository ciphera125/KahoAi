import { logger } from "../utils/logger.js";

export const notFound = (_req, res) => res.status(404).json({ error: "not found" });

/** A database that is full or slow, or a pool being closed: the person should try again in a moment, and the log should say it is load, not a bug. */
const BUSY_CODES = new Set(["53300", "57014", "57P01"]);
const BUSY_TEXT = /timeout exceeded when trying to connect|Connection terminated|Cannot use a pool after calling end|too many clients/i;
const isBusy = (err) => BUSY_CODES.has(err?.code) || BUSY_TEXT.test(String(err?.message ?? ""));

/** One place that turns an error into a response. Unexpected errors are logged
 * with the request id and answered with a generic message: no stack, no SQL. */
export function errorHandler(err, req, res, _next) {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "the request is too large" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "the request is not valid JSON" });
  if (err.expose && err.status >= 400 && err.status < 600) return res.status(err.status).json({ error: err.message });
  if (isBusy(err)) {
    logger.warn({ err: { message: err.message, code: err.code }, reqId: req.id }, "database busy; answered 503");
    if (res.headersSent) return res.end();
    return res.set("Retry-After", "2").status(503).json({ error: "the service is busy right now; try again in a moment" });
  }
  logger.error({ err: { message: err.message, code: err.code, stack: err.stack }, reqId: req.id }, "request failed");
  if (res.headersSent) return res.end();
  res.status(500).json({ error: "something went wrong on our side; try again" });
}
