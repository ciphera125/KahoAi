// The admin site's own door. Its cookie is named and scoped apart from the Studio's, so neither
// session can open the other's API, and it is only ever sent to /api/admin.
import { config } from "../config/env.js";
import * as Admin from "../models/Admin.js";
import { AuthError } from "../utils/errors.js";

export const ADMIN_COOKIE = "kaho_admin";

export const adminCookieOptions = () => ({
  httpOnly: true, sameSite: "strict", secure: config.cookieSecure, path: "/api/admin", maxAge: Admin.SESSION_SECS * 1000,
});

export async function requireAdmin(req, _res, next) {
  try {
    const admin = await Admin.forSessionToken(req.cookies?.[ADMIN_COOKIE]);
    if (!admin) return next(new AuthError("sign in to the admin site first"));
    req.admin = admin;
    next();
  } catch (err) {
    next(err);
  }
}
