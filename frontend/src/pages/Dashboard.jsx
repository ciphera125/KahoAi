import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get } from "../api.js";
import { chartFacts } from "../chart.js";
import { dayWord } from "../time.js";
import { fmtTalk, Icon, OutcomePill, plural, Spinner, useToast, whenShort } from "../ui.jsx";

export default function Dashboard() {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
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
  const chart = chartFacts(d.by_day);

  const tiles = [
    ["Calls made", t.calls.toLocaleString(), `${t.people.toLocaleString()} ${t.people === 1 ? "person" : "people"} called`, null, "call"],
    ["Picked up", `${d.rates.answer}%`, `${t.answered} of ${finished}`, d.rates.answer, "check"],
    ["Real conversations", `${d.rates.success}%`, `${t.successful} calls where the person actually talked`, d.rates.success, "chat"],
    ["Avg. talk time", fmtTalk(d.talk.avg_secs), "on answered calls", null, "clock"],
    ["Minutes talked", d.talk.total_minutes.toLocaleString(), `${t.leads} ${t.leads === 1 ? "lead" : "leads"} saved`, null, "live"],
  ];
  return (
    <section>
      <header className="page">
        <div><h1>Overview</h1><div className="sub">Your calls at a glance: how many were made, how many people picked up, and how many had a real conversation. Pick a period on the right.</div></div>
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
        </div>
      </header>
      {t.calls === 0 && (
        <div className="card start-card">
          <div className="card-head"><span className="card-title">Getting started: four steps to your first call</span></div>
          <ol className="start-steps">
            <li><Link to="/numbers"><b>1. Add a phone number</b><span>The number your calls come from.</span></Link></li>
            <li><Link to="/agents"><b>2. Make an agent</b><span>Choose what the AI says and in which language.</span></Link></li>
            <li><Link to="/contacts"><b>3. Add someone to call</b><span>A name, a number, and their permission.</span></Link></li>
            <li><Link to="/calls"><b>4. Place a call</b><span>Press Call now and watch it live.</span></Link></li>
          </ol>
        </div>
      )}
      <div className="kpis">
        {tiles.map(([k, v, s, pct, icon]) => (
          <div className="kpi" key={k}>
            <span className="kpi-icon"><Icon name={icon} /></span>
            <span className="k">{k}</span><span className="v">{v}</span><span className="muted">{s}</span>
            {pct != null && <div className="meter"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>}
          </div>
        ))}
      </div>
      <div className="grid-2" style={{ marginBottom: "var(--s6)" }}>
        <div className="card">
          <div className="card-head"><span className="card-title">How calls ended</span><span className="muted">{plural(t.calls, "call")}</span></div>
          <p className="hint" style={{ marginBottom: "var(--s3)" }}>Every call ends in one of these ways. The bar shows its share of all calls.</p>
          {[["answered", "Picked up", "ok"], ["no_answer", "No answer", "warn"], ["declined", "Declined or busy", "warn"], ["failed", "Failed", "bad"], ["ringing", "Ringing or not known yet", "muted"]].map(([k, l, tone]) => {
            const pct = t.calls ? Math.round((100 * t[k]) / t.calls) : 0;
            return (
              <div key={k} className="outcome-row">
                <div className="outcome-top"><span>{l}</span><span className="num">{t[k]} <span className="muted">({pct}%)</span></span></div>
                <div className="meter"><i className={`tone-${tone}`} style={{ width: `${pct}%` }} /></div>
              </div>
            );
          })}
          <p className="hint" style={{ marginTop: "var(--s3)" }}>A real conversation means the person picked up and actually talked. {d.rates.conversion}% of answered calls got there.</p>
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title">Calls per day</span><span className="muted">{plural(chart.calls, "call")}</span></div>
          <p className="hint" style={{ marginBottom: "var(--s3)" }}>Each bar is one day. The whole bar is every call made that day; the coloured part is the calls that were picked up.</p>
          <div className="legend">
            <span><i className="swatch all" />Calls made</span><span><i className="swatch picked" />Picked up ({chart.answered})</span>
          </div>
          <div className="chart">
            <div className="y-axis"><span>{chart.top}</span><span>{Math.round(chart.top / 2)}</span><span>0</span></div>
            <div className="bars">
              {d.by_day.map((x) => (
                <div className="b" key={x.date} title={`${dayWord(x.date)}: ${plural(x.calls, "call")}, ${x.answered} picked up`} style={{ height: `${(100 * x.calls) / chart.top}%` }}>
                  <i style={{ height: `${x.calls ? (100 * x.answered) / x.calls : 0}%` }} />
                </div>
              ))}
            </div>
          </div>
          <div className="x-axis">{chart.ticks.map((x) => <span key={x.date}>{dayWord(x.date)}</span>)}</div>
          <p className="hint" style={{ marginTop: "var(--s2)" }}>
            {chart.busiest ? `Busiest day: ${dayWord(chart.busiest.date)}, with ${plural(chart.busiest.calls, "call")} (${chart.busiest.answered} picked up).` : "No calls in this time yet."}
          </p>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><span className="card-title">Latest calls</span></div>
        <p className="hint" style={{ marginBottom: "var(--s2)" }}>The most recent calls, newest first. Open Calls to read or hear any of them.</p>
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
