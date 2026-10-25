// The voice service's door: a bearer token shared only between our two services.
import { config } from "../config/env.js";
import { safeEqual } from "../utils/crypto.js";
import { HttpError } from "../utils/errors.js";

export function requireServiceToken(req, _res, next) {
  const header = req.headers.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !safeEqual(presented, config.INTERNAL_API_TOKEN)) {
    return next(new HttpError(401, "service token required"));
  }
  next();
}
