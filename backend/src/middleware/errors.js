import { logger } from "../utils/logger.js";

export const notFound = (_req, res) => res.status(404).json({ error: "not found" });

/** One place that turns an error into a response. Unexpected errors are logged
 * with the request id and answered with a generic message: no stack, no SQL. */
export function errorHandler(err, req, res, _next) {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "the request is too large" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "the request is not valid JSON" });
  if (err.expose && err.status >= 400 && err.status < 600) return res.status(err.status).json({ error: err.message });
  logger.error({ err: { message: err.message, code: err.code, stack: err.stack }, reqId: req.id }, "request failed");
  if (res.headersSent) return res.end();
  res.status(500).json({ error: "something went wrong on our side; try again" });
}
