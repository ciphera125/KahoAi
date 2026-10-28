import * as ErrorLog from "../models/ErrorLog.js";

export async function list(req, res) {
  res.json(await ErrorLog.list(req.user.org_id, { limit: req.query.limit }));
}
