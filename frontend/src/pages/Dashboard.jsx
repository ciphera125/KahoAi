import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, post } from "../api.js";
import { isAdmin, useMe } from "../auth.jsx";
import { fmtTalk, Icon, OutcomePill, plural, Spinner, useToast, whenShort } from "../ui.jsx";

export default function Dashboard() {
  const me = useMe();
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [active, setActive] = useState(null);
  const load = () => { setErr(null); get(`/api/dashboard?days=${days}`).then(setD).catch((e) => { setErr(e.message); toast(e.message, true); }); };
  useEffect(() => { setD(null); load(); /* eslint-disable-next-line */ }, [days]);
  useEffect(() => {
    const poll = () => get("/api/calls/active").then((c) => setActive(c.length)).catch(() => {});
    poll();
    const t = setInterval(poll, 10000);
    return () => clearInterval(t);
  }, []);

  if (err && !d) {
    return (
      <section>
        <header className="page"><div><h1>Overview</h1></div></header>
        <div className="card"><div className="empty">Could not load the dashboard. {err}</div>
          <div className="actions" style={{ justifyContent: "flex-start", marginTop: "var(--s3)" }}>
            <button className="ghost" onClick={load}><Icon name="refresh" />Retry</button>
          </div>
        </div>
      </section>
    );
  }
  if (!d) return <Spinner />;

  const t = d.totals, finished = t.calls - t.ringing;
  const sync = async () => { setSyncing(true); try { const r = await post("/api/dashboard/sync"); toast(`Read ${plural(r.synced, "call")} from Plivo.`); load(); } catch (e) { toast(e.message, true); } finally { setSyncing(false); } };
  const top = Math.max(1, ...d.by_day.map((x) => x.calls));

  const tiles = [
    ["Calls made", t.calls.toLocaleString(), `${t.people.toLocaleString()} ${t.people === 1 ? "person" : "people"} called`],
    ["Picked up", `${d.rates.answer}%`, `${t.answered} of ${finished}`, d.rates.answer],
    ["Successful", `${d.rates.success}%`, `${t.successful} real conversations`, d.rates.success],
    ["Avg. talk time", fmtTalk(d.talk.avg_secs), "on answered calls"],
    ["Minutes talked", d.talk.total_minutes.toLocaleString(), `${t.leads} ${t.leads === 1 ? "lead" : "leads"} saved`],
  ];
  return (
    <section>
      <header className="page">
        <div><h1>Overview</h1><div className="sub">How your calls are going: who picked up, who talked, and when.</div></div>
        <div className="head-actions">
          {active > 0 && (
            <Link to="/live" className="btn ghost" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ok)", display: "inline-block" }} />
              {plural(active, "call")} live
            </Link>
          )}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 150 }}>
            <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
          </select>
          {isAdmin(me) && <button type="button" className="ghost" onClick={sync} disabled={syncing}><Icon name="refresh" />Sync with Plivo</button>}
        </div>
      </header>
      <div className="kpis">
        {tiles.map(([k, v, s, pct]) => (
          <div className="kpi" key={k}>
            <span className="k">{k}</span><span className="v">{v}</span><span className="muted">{s}</span>
            {pct != null && <div className="meter"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>}
          </div>
        ))}
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="card-head"><span className="card-title">How calls ended</span><span className="muted">{plural(t.calls, "call")}</span></div>
          {[["answered", "Picked up"], ["no_answer", "No answer"], ["declined", "Declined or busy"], ["failed", "Failed"], ["ringing", "Ringing / unknown"]].map(([k, l]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <span>{l}</span><span className="num">{t[k]} · {t.calls ? Math.round((100 * t[k]) / t.calls) : 0}%</span>
            </div>
          ))}
          <p className="hint" style={{ marginTop: "var(--s3)" }}>Successful = picked up and the person really talked. {d.rates.conversion}% of answered calls got there.</p>
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title">Calls per day</span></div>
          <div className="bars">
            {d.by_day.map((x) => (
              <div className="b" key={x.date} title={`${whenShort(x.date)}: ${plural(x.calls, "call")}, ${x.answered} picked up`} style={{ height: `${(100 * x.calls) / top}%` }}>
                <i style={{ height: `${x.calls ? (100 * x.answered) / x.calls : 0}%` }} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="card" style={{ marginTop: "var(--s4)" }}>
        <div className="card-head"><span className="card-title">Latest calls</span></div>
        {d.recent.length === 0 && <div className="hint">No calls yet. Start one from Calls.</div>}
        {d.recent.map((c) => (
          <div key={c.call_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ minWidth: 0 }}>
              <b className="ellip">{c.contact_name || c.peer || "Unknown number"}</b>
              <div className="muted ellip">{[whenShort(c.started_at), c.agent_name].filter(Boolean).join(" · ")}</div>
            </div>
            <OutcomePill status={c.status} />
          </div>
        ))}
      </div>
    </section>
  );
}
