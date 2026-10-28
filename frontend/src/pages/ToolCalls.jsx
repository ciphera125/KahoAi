import { useEffect, useState } from "react";
import { get } from "../api.js";
import { Spinner, useToast, whenShort } from "../ui.jsx";

export default function ToolCalls() {
  const toast = useToast();
  const [data, setData] = useState(null);
  useEffect(() => { get("/api/calls/tools?limit=100").then(setData).catch((e) => toast(e.message, true)); }, []);
  if (!data) return <Spinner />;
  return (
    <section>
      <header className="page">
        <div><h1>Tool Calls</h1><div className="sub">Every tool an agent invoked during a call.</div></div>
      </header>
      <div className="card list">
        <div className="row head" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 120px" }}>
          <span>Tool</span><span>Call</span><span>Contact</span><span>When</span>
        </div>
        {data.length === 0 && <div className="empty">No tool calls yet. Agents call tools like end_call, capture_lead and transfer_to_human during conversations.</div>}
        {data.map((t) => (
          <div key={t.id} className="row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 120px" }}>
            <span className="code">{t.tool}</span>
            <span className="muted ellip">{t.call_id}</span>
            <span className="ellip">{t.peer || "—"}</span>
            <span className="muted">{t.at ? whenShort(t.at) : "—"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
