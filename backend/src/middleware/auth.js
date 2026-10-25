import { config } from "../config/env.js";
import * as User from "../models/User.js";
import { forbidden, HttpError } from "../utils/errors.js";

export const SESSION_COOKIE = "kaho_session";
export const DEVICE_COOKIE = "kaho_device"; // a browser that has signed in; see models/User.js

export const cookieOptions = (maxAgeSecs) => ({
  httpOnly: true, sameSite: "strict", secure: config.cookieSecure, path: "/", maxAge: maxAgeSecs * 1000,
});

/** The signed-in user, or 401. */
export async function requireSession(req, _res, next) {
  try {
    const user = await User.forSessionToken(req.cookies?.[SESSION_COOKIE]);
    if (!user) return next(new HttpError(401, "sign in first"));
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Members do the daily work; the owner alone changes numbers and their
 * credentials, deletes agents and prompts, deletes in bulk and syncs from Plivo. */
export function requireOwner(req, _res, next) {
  if (req.user?.role !== "owner") return next(forbidden("only the organization's owner can do this"));
  next();
}

/** Owner or admin: numbers and credentials, deleting agents and prompts, bulk
 * deletes, syncing from Plivo, invites and removing members. */
export function requireAdmin(req, _res, next) {
  if (!["owner", "admin"].includes(req.user?.role)) return next(forbidden("only an admin of this organization can do this"));
  next();
}
