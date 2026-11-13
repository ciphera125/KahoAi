import * as ErrorLog from "../models/ErrorLog.js";
import * as Audit from "../models/Audit.js";

export async function list(req, res) {
  const status = req.query.status === "acknowledged" ? "acknowledged" : "open";
  res.json(await ErrorLog.list(req.user.org_id, { limit: req.query.limit, status }));
}

export async function acknowledge(req, res) {
  const { ids, acknowledged } = req.body ?? {};
  const changed = await ErrorLog.acknowledge(req.user.org_id, ids, acknowledged, req.user.name);
  if (changed > 0) {
    await Audit.record(req.user.org_id, { actor: req.user.name, role: req.user.role, action: "errors",
      detail: `${req.user.name} ${acknowledged ? "acknowledged" : "reopened"} ${changed} error${changed === 1 ? "" : "s"}` })
      .catch(() => {});
  }
  res.json({ changed });
}
