// The door for another system pushing data in: a key, not a session.
//
// The organization comes from the key and is put on the request here. Nothing downstream
// may read an organization from the body, so a key can only ever write into its own.
import * as ApiKey from "../models/ApiKey.js";
import { AuthError } from "../utils/errors.js";

export async function requireApiKey(req, _res, next) {
  const header = req.headers.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const orgId = presented ? await ApiKey.orgFor(presented) : null;
  if (!orgId) return next(new AuthError("a valid API key is required", 401));
  req.apiOrgId = orgId;
  next();
}
