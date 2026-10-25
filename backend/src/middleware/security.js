// What every /api request must pass before any work is done for it.
import helmet from "helmet";
import { config } from "../config/env.js";
import { forbidden, HttpError } from "../utils/errors.js";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Only our own hosts (no DNS rebinding) and, unless behind a trusted proxy, no forwarded requests. */
export function hostCheck(req, _res, next) {
  const forwarded = req.headers["x-forwarded-for"] || req.headers.forwarded;
  if (!config.hosts.includes(req.headers.host) || (forwarded && !config.trustProxy)) {
    return next(forbidden("this server only answers to its own address"));
  }
  next();
}

/** Cross-site protection: a request from another site's page is refused, and a
 * state change must say which page sent it (browsers always do). */
export function originCheck(req, _res, next) {
  const origin = req.headers.origin;
  if (origin ? !config.origins.includes(origin) : UNSAFE.has(req.method)) {
    return next(forbidden("requests must come from the Studio itself"));
  }
  next();
}

/** A body, if there is one, must be JSON. */
export function jsonOnly(req, _res, next) {
  const hasBody = Number(req.headers["content-length"] || 0) > 0 || req.headers["transfer-encoding"];
  if (UNSAFE.has(req.method) && hasBody && !req.is("application/json")) {
    return next(new HttpError(415, "send JSON"));
  }
  next();
}

export const apiHeaders = [
  helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    hsts: config.production,
  }),
  (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); },
];
