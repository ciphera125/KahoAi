// What is happening on the platform, and what is waiting for a person at Kaho.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, qs } from "../api.js";
import { minutesText, rupees } from "../../../frontend/src/billing.js";
import { startPolling } from "../../../frontend/src/poll.js";
import { Spinner, useToast, whenShort } from "../../../frontend/src/ui.jsx";
import { Head, n, RequestCard } from "../parts.jsx";

function Kpi({ label, value, sub }) {
  return <div className="kpi"><span className="k">{label}</span><span className="v">{value}</span>{sub && <span className="muted">{sub}</span>}</div>;
}

export default function Overview() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [waiting, setWaiting] = useState(null);
  const load = useCallback(async () => {
    try {
      const [o, topups, pending, requested, asks] = await Promise.all([get("/overview"), get(`/topups${qs({ status: "pending", per_page: 10 })}`),
        get(`/orgs${qs({ status: "pending", per_page: 10 })}`), get(`/orgs${qs({ status: "requested", per_page: 10 })}`), get(`/requests${qs({ status: "open", per_page: 10 })}`)]);
      setD(o); setWaiting({ topups: topups.topups, plans: pending.orgs, moves: requested.orgs, asks: asks.requests });
    } catch (e) { toast(e.message, true); }
  }, [toast]);
  useEffect(() => { load(); return startPolling(load, 30000); }, [load]);
  if (!d || !waiting) return <Spinner />;
  const o = d.orgs;
  return (
    <section>
      <Head title="Overview" sub="Every organization on the platform, and what needs a person at Kaho." />
      <div className="kpis six">
        <Kpi label="Organizations" value={n(o.total)} sub={`${n(o.active)} on a plan`} />
        <Kpi label="Requests waiting" value={n(d.requests.open)} sub="plan changes and messages" />
        <Kpi label="Waiting for payment" value={n(o.pending)} sub="chose a plan, not yet confirmed" />
        <Kpi label="Monthly plans" value={rupees(d.revenue.mrr_paise)} sub="active plans, before top-ups" />
        <Kpi label="Top-ups waiting" value={n(d.topups.pending)} sub={`${rupees(d.topups.pending_paise)} to confirm`} />
        <Kpi label="Top-ups paid, 30 days" value={rupees(d.topups.paid_30d_paise)} />
        <Kpi label="Minutes used, 30 days" value={minutesText(d.minutes.used_30d)} />
        <Kpi label="People" value={n(d.users.total)} sub={d.users.disabled ? `${n(d.users.disabled)} switched off` : undefined} />
        <Kpi label="Calls today" value={n(d.calls.today)} sub={`${n(d.calls.live)} on the line now`} />
      </div>
      <div className="card requests-panel">
        <div className="card-head"><span className="card-title">Requests from organizations{d.requests.open > 0 && <span className="req-count" style={{ marginLeft: 8 }}>{d.requests.open} waiting</span>}</span><Link to="/requests" className="btn ghost">Open all</Link></div>
        {waiting.asks.length === 0 ? <p className="hint">No requests are waiting.</p> : <div className="req-grid">{waiting.asks.slice(0, 4).map((r) => <RequestCard key={r.id} r={r} />)}</div>}
      </div>
      <div className="cols">
        <div className="card">
          <div className="card-head"><span className="card-title">Top-ups to confirm</span><Link to="/topups" className="btn ghost">All top-ups</Link></div>
          {waiting.topups.length === 0 ? <p className="hint">Nothing waiting.</p> : (
            <table className="rows"><tbody>{waiting.topups.map((t) => (
              <tr key={t.id}><td><Link to={`/orgs/${t.org_id}`}>{t.org_name}</Link><div className="hint">{whenShort(t.created_at)} · <span className="code">{t.reference}</span></div></td>
                <td>{minutesText(t.minutes)}</td><td><b>{rupees(t.amount_paise)}</b></td></tr>))}</tbody></table>
          )}
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title">Chose a plan, waiting for payment</span><Link to="/orgs?status=pending" className="btn ghost">See all</Link></div>
          {waiting.plans.length === 0 ? <p className="hint">Nobody is waiting.</p> : (
            <table className="rows"><tbody>{waiting.plans.map((x) => (
              <tr key={x.id}><td><Link to={`/orgs/${x.id}`}>{x.name}</Link><div className="hint">{x.owner_email}</div></td><td>{x.plan_name}</td></tr>))}</tbody></table>
          )}
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title">Asked to change plan</span><Link to="/orgs?status=requested" className="btn ghost">See all</Link></div>
          {waiting.moves.length === 0 ? <p className="hint">No requests.</p> : (
            <table className="rows"><tbody>{waiting.moves.map((x) => (
              <tr key={x.id}><td><Link to={`/orgs/${x.id}`}>{x.name}</Link><div className="hint">{x.owner_email}</div></td><td>{x.plan_name} to {x.requested_plan_id}</td></tr>))}</tbody></table>
          )}
        </div>
      </div>
    </section>
  );
}
