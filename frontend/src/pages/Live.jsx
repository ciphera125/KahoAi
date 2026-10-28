import { useCallback, useEffect, useState } from "react";
import { get } from "../api.js";
import { Spinner, useToast, whenShort } from "../ui.jsx";

export default function Live() {
  const toast = useToast();
  const [calls, setCalls] = useState(null);
  const load = useCallback(() => get("/api/calls/active").then(setCalls).catch((e) => toast(e.message, true)), []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  if (!calls) return <Spinner />;
  return (
    <section>
      <header className="page">
        <div><h1>Live</h1><div className="sub">Calls currently in progress. Refreshes every 5 seconds.</div></div>
      </header>
      {calls.length === 0 ? (
        <div className="card"><div className="empty">No active calls right now.</div></div>
      ) : (
        <div className="card list">
          <div className="row head" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 80px minmax(0,1fr) 120px" }}>
            <span>Contact</span><span>Agent</span><span>Status</span><span>Call ID</span><span>Started</span>
          </div>
          {calls.map((c) => (
            <div key={c.call_id} className="row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 80px minmax(0,1fr) 120px" }}>
              <span className="ellip">{c.contact_name || c.peer || "Unknown"}</span>
              <span className="ellip">{c.agent_name || c.agent_id || "—"}</span>
              <span><span className={`badge ${c.status === "answered" ? "ok" : ""}`}>{c.status}</span></span>
              <span className="muted ellip">{c.call_id}</span>
              <span className="muted">{c.started_at ? whenShort(c.started_at) : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
