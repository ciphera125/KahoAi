import * as Lead from "../models/Lead.js";

export async function list(req, res) {
  res.json(await Lead.list(req.user.org_id, { limit: req.query.limit }));
}
