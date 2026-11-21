import { useCallback, useEffect, useState } from "react";
import { get } from "../api.js";
import { Info, Spinner, usePaged, useToast, whenShort } from "../ui.jsx";
import { startPolling } from "../poll.js";

export default function Live() {
  const toast = useToast();
  const [calls, setCalls] = useState(null);
  const load = useCallback(() => get("/api/calls/active").then(setCalls).catch((e) => toast(e.message, true)), []);
  useEffect(() => { load(); return startPolling(load, 5000); }, [load]);
  const [shownCalls, callPager] = usePaged(calls ?? []);
  if (!calls) return <Spinner />;
  return (
    <section>
      <header className="page">
        <div><h1>Live<Info text="Calls happening right now. Open one to read the conversation as it is spoken." /></h1><div className="sub">Calls currently in progress. Refreshes every 5 seconds.</div></div>
      </header>
      {calls.length === 0 ? (
        <div className="card"><div className="empty">No active calls right now.</div></div>
      ) : (
        <div className="card list">
          <div className="row head" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 80px minmax(0,1fr) 120px" }}>
            <span>Contact</span><span>Agent</span><span>Status</span><span>Call ID</span><span>Started</span>
          </div>
          {shownCalls.map((c) => (
            <div key={c.call_id} className="row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 80px minmax(0,1fr) 120px" }}>
              <span className="ellip">{c.contact_name || c.peer || "Unknown"}</span>
              <span className="ellip">{c.agent_name || c.agent_id || "-"}</span>
              <span><span className={`badge ${c.status === "answered" ? "ok" : ""}`}>{c.status}</span></span>
              <span className="muted ellip">{c.call_id}</span>
              <span className="muted">{c.started_at ? whenShort(c.started_at) : "-"}</span>
            </div>
          ))}
        </div>
      )}
      {calls.length > 0 && callPager}
    </section>
  );
}
