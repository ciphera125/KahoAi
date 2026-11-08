import * as Audit from "../models/Audit.js";

const cell = (text) => {
  const t = String(text ?? "");
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export async function list(req, res) {
  res.json(await Audit.page(req.user.org_id, { page: req.query.page, perPage: req.query.per_page, q: req.query.q }));
}

export async function csv(req, res) {
  const rows = await Audit.all(req.user.org_id);
  const lines = ["time,who,role,what,detail", ...rows.map((r) => [r.at, r.actor, r.role, r.action, r.detail].map(cell).join(","))];
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="audit-log.csv"');
  res.send(`${lines.join("\r\n")}\r\n`);
}
