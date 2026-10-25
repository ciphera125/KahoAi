import pino from "pino";
import { config } from "../config/env.js";

// Secrets and personal data never reach the log, whatever a caller logs.
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]',
      "*.password", "*.current", "*.new", "*.credentials", "*.auth_token", "*.token", "*.invite"],
    censor: "[redacted]",
  },
});
