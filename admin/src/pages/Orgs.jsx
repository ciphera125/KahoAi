// Every organization: find one, see its plan and balance, open it.
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { get, qs } from "../api.js";
import { minutesText } from "../../../frontend/src/billing.js";
import { serverView } from "../../../frontend/src/paginate.js";
import { Pager, Spinner, useToast } from "../../../frontend/src/ui.jsx";
import { dateOf, Head, StatusPill, useDebounced } from "../parts.jsx";

const FILTERS = [["", "All"], ["active", "Active"], ["pending", "Waiting for payment"], ["expired", "Ended"], ["suspended", "Suspended"],
  ["cancelled", "Cancelled"], ["none", "No plan"], ["requested", "Asked to change plan"], ["unmetered", "No minute limit"]];

export default function Orgs() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const [q, setQ] = useState("");
  const find = useDebounced(q);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [d, setD] = useState(null);
  useEffect(() => { setPage(1); }, [find, status, size]);
  useEffect(() => {
    get(`/orgs${qs({ q: find, status, page, per_page: size })}`).then(setD).catch((e) => toast(e.message, true));
  }, [find, status, page, size, toast]);
  return (
    <section>
      <Head title="Organizations" sub="Every team on the platform. Open one to change its plan, its rates, its people or its minutes." />
      <div className="chips">
        {FILTERS.map(([id, label]) => <button key={id} type="button" className={`chip${status === id ? " on" : ""}`} onClick={() => setParams(id ? { status: id } : {})}>{label}</button>)}
      </div>
      <div className="card list">
        <div className="list-bar"><input type="search" value={q} placeholder="Search by name, owner or e-mail" aria-label="Search organizations" onChange={(e) => setQ(e.target.value)} />
          <span className="grow" /><span className="muted">{d ? `${d.total.toLocaleString("en-IN")} found` : ""}</span></div>
        {!d ? <Spinner /> : d.orgs.length === 0 ? <div className="empty">No organization matches.</div> : (
          <div className="table-wrap"><table className="rows"><thead><tr><th>Organization</th><th>Requests</th><th>Plan</th><th>Status</th><th>Minutes left</th><th>People</th><th>Calls, 30 days</th><th>Runs until</th></tr></thead>
            <tbody>{d.orgs.map((o) => (
              <tr key={o.id} className="click" onClick={() => navigate(`/orgs/${o.id}`)}>
                <td><b>{o.name}</b><div className="hint">{o.owner_email ?? "-"}</div></td>
                <td>{o.open_requests > 0 ? <span className="req-count" title="Waiting for you">{o.open_requests} waiting</span> : <span className="muted">0</span>}</td>
                <td>{o.plan_name ?? "-"}{o.requested_plan_id && <div className="hint">wants {o.requested_plan_id}</div>}</td>
                <td><StatusPill status={o.status} unmetered={o.unmetered} /></td>
                <td className="num">{o.unmetered ? "No limit" : o.balance_minutes === null ? "-" : minutesText(o.balance_minutes)}</td>
                <td className="num">{o.members}</td><td className="num">{o.calls_30d}</td><td>{dateOf(o.period_end)}</td></tr>))}</tbody></table></div>
        )}
      </div>
      {d && <Pager view={serverView({ page: d.page, total: d.total, size: d.per_page })} size={d.per_page} onPage={setPage} onSize={(x) => { setSize(x); setPage(1); }} />}
    </section>
  );
}
