// Small pieces the admin pages share.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, qs } from "./api.js";
import { STATUS_WORDS } from "../../frontend/src/billing.js";
import { serverView } from "../../frontend/src/paginate.js";
import { Icon, Pager, useToast, whenShort } from "../../frontend/src/ui.jsx";

export const STATUS_PILL = { active: "active", pending: "warn", expired: "failed", suspended: "failed", cancelled: "muted" };

/** A plan's status as a pill, with "No plan" when there is none. */
export function StatusPill({ status, unmetered = false }) {
  if (!status) return <span className="pill muted">No plan</span>;
  return (
    <span className="status-line">
      <span className={`pill ${STATUS_PILL[status] ?? "muted"}`}>{STATUS_WORDS[status] ?? status}</span>
      {unmetered && <span className="pill live">No limit</span>}
    </span>
  );
}

export function Head({ title, sub, children }) {
  return (
    <header className="page">
      <div><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
      {children && <div className="head-actions">{children}</div>}
    </header>
  );
}

/** A value that settles 250 ms after the person stops typing. */
export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export const dateOf = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "-");
export const n = (v) => Number(v ?? 0).toLocaleString("en-IN");

/** A list the server pages (10, 25 or 50 a page): its current page, and the pager to put under it. `again` refetches. */
export function useServerPage(path, params = {}) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [d, setD] = useState(null);
  const key = JSON.stringify(params);
  const [tick, setTick] = useState(0);
  useEffect(() => { setPage(1); }, [key, size]);
  useEffect(() => {
    let live = true;
    get(`${path}${qs({ ...JSON.parse(key), page, per_page: size })}`).then((x) => { if (live) setD(x); }).catch((e) => toast(e.message, true));
    return () => { live = false; };
  }, [path, key, page, size, tick, toast]);
  const pager = d && d.total > 0 ? <Pager view={serverView({ page: d.page, total: d.total, size: d.per_page })} size={d.per_page} onPage={setPage} onSize={(x) => { setSize(x); setPage(1); }} /> : null;
  return [d, pager, () => setTick((t) => t + 1)];
}

/** One request, made easy to read: what kind it is, who asked, what they want and what they are on now. */
export function RequestCard({ r, onAnswer, showOrg = true }) {
  const plan = r.kind === "plan_change";
  return (
    <div className={`req-card ${plan ? "plan" : "msg"}${r.status === "open" ? " open" : ""}`}>
      <div className="req-top">
        <span className={`pill ${plan ? "warn" : "live"}`}>{plan ? "Plan change" : "Message"}</span>
        {showOrg && <Link to={`/orgs/${r.org_id}`}><b>{r.org_name}</b></Link>}
        <span className="muted">{r.created_by} · {whenShort(r.created_at)}</span>
        {r.status !== "open" && <span className={`pill ${r.status === "done" ? "active" : "muted"}`}>{r.status === "done" ? "Answered" : "Closed"}</span>}
      </div>
      {plan && <div className="req-move"><span>{r.current_plan_name ?? "No plan"}</span><Icon name="back" /><b>{r.plan_name ?? r.plan_id}</b></div>}
      {r.message && <p className="req-text">{r.message}</p>}
      {r.response && <p className="hint">Your answer: {r.response}</p>}
      {r.status === "open" && onAnswer && <div className="actions"><button type="button" className="primary small-btn" onClick={() => onAnswer(r, "done")}>{plan ? "Mark handled" : "Answer"}</button>
        <button type="button" className="ghost small-btn" onClick={() => onAnswer(r, "dismiss")}>Dismiss</button></div>}
    </div>
  );
}
