import { useEffect, useState } from "react";
import { get } from "../api.js";
import { Spinner, useToast } from "../ui.jsx";

const RANGES = [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"]];
const n = (v) => Number(v ?? 0).toLocaleString("en-IN");

/** Minutes used, shown as a tab in Settings. */
export default function Usage() {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    get(`/api/usage?days=${days}`).then(setD).catch((e) => toast(e.message, true));
  }, [days, toast]);
  const top = Math.max(1, ...(d?.by_day ?? []).map((x) => x.minutes));

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>Minutes your agents have spent on calls. Each call counts up to its next whole minute.</p>
      <div className="seg" style={{ marginBottom: "var(--s4)" }}>
        {RANGES.map(([v, l]) => <button key={v} className={days === v ? "on" : ""} onClick={() => setDays(v)}>{l}</button>)}
      </div>
      {!d ? <Spinner /> : (
        <>
          <div className="kpis" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
            {[["Minutes used", n(d.total.minutes)], ["Calls with talk time", n(d.total.calls)],
              ["Average call", `${d.total.calls ? Math.round(d.total.seconds / d.total.calls) : 0}s`]].map(([k, v]) => (
              <div className="kpi" key={k}><span className="k">{k}</span><span className="v">{v}</span></div>))}
          </div>
          {d.total.calls === 0 ? <div className="card"><p className="hint">No calls with talk time in this period.</p></div> : (
            <>
              <div className="card">
                <div className="card-head"><span className="card-title">Minutes per day</span></div>
                <div className="usage-bars" role="img" aria-label="Minutes used each day">
                  {d.by_day.map((x) => (
                    <div key={x.day} className="usage-bar" title={`${x.day}: ${n(x.minutes)} minutes, ${n(x.calls)} calls`}>
                      <i style={{ height: `${Math.max(4, (x.minutes / top) * 100)}%` }} /><span>{x.day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card">
                <div className="card-head"><span className="card-title">By agent</span></div>
                <table className="rows"><thead><tr><th>Agent</th><th>Calls</th><th>Minutes</th></tr></thead>
                  <tbody>{d.by_agent.map((a) => <tr key={a.agent_id ?? a.name}><td>{a.name}</td><td>{n(a.calls)}</td><td>{n(a.minutes)}</td></tr>)}</tbody></table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
