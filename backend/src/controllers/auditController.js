import * as Audit from "../models/Audit.js";

const cell = (text) => {
  const t = String(text ?? "");
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export async function list(req, res) {
  res.json(await Audit.page(req.user.org_id, { page: req.query.page, perPage: req.query.per_page, q: req.query.q, from: req.query.from, to: req.query.to }));
}

const IST = { timeZone: "Asia/Kolkata", hourCycle: "h23" };
const dayOf = (iso) => new Date(iso).toLocaleDateString("en-CA", IST);
const timeOf = (iso) => new Date(iso).toLocaleTimeString("en-GB", { ...IST, hour: "2-digit", minute: "2-digit" });

export async function csv(req, res) {
  const rows = await Audit.all(req.user.org_id, { from: req.query.from, to: req.query.to });
  const lines = ["date,time,who,role,what,detail",
    ...rows.map((r) => [dayOf(r.at), timeOf(r.at), r.actor, r.role, r.action, r.detail].map(cell).join(","))];
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="audit-log.csv"');
  res.send(`${lines.join("\r\n")}\r\n`);
}
