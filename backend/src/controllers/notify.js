import * as Audit from "../models/Audit.js";
import * as Activity from "../models/Activity.js";
import { logger } from "../utils/logger.js";

/** A notification for everyone in the workspace. Never fails the change itself. */
export async function note(req, kind, text, view, ref = null) {
  // Kaho support signed in as this person: the record says so, so nobody is blamed for what support did.
  const actor = req.user?.support ? `${req.user.name} (Kaho support)` : req.user?.name;
  try {
    await Activity.add(req.user.org_id, kind, text, { view, ref, actor });
  } catch (err) {
    logger.warn({ err: err.message }, "could not record a notification");
  }
  // The audit record is separate, so one failing never hides the other.
  try {
    await Audit.record(req.user.org_id, { actor, role: req.user?.role, action: kind, detail: text, ref });
  } catch (err) {
    logger.warn({ err: err.message }, "could not write the audit log");
  }
}
