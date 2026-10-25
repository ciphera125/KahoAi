import * as Activity from "../models/Activity.js";
import { logger } from "../utils/logger.js";

/** A notification for everyone in the workspace. Never fails the change itself. */
export async function note(req, kind, text, view, ref = null) {
  try {
    await Activity.add(req.user.org_id, kind, text, { view, ref, actor: req.user?.name });
  } catch (err) {
    logger.warn({ err: err.message }, "could not record a notification");
  }
}
