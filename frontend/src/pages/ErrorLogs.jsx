import { useEffect, useState } from "react";
import { get } from "../api.js";
import { Spinner, useToast, whenShort } from "../ui.jsx";

const BADGE = { error: "bad", warn: "warn" };

export default function ErrorLogs() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const load = () => get("/api/errors?limit=100").then((r) => setData(r.errors)).catch((e) => toast(e.message, true));
  useEffect(() => { load(); }, []);
  if (!data) return <Spinner />;
  return (
    <section>
      <header className="page">
        <div><h1>Error Logs</h1><div className="sub">System errors reported by the voice service during calls.</div></div>
        <div className="head-actions"><button className="ghost" onClick={load}>Refresh</button></div>
      </header>
      <div className="card list">
        <div className="row head" style={{ gridTemplateColumns: "70px minmax(0,0.8fr) minmax(0,2fr) 100px 120px" }}>
          <span>Level</span><span>Source</span><span>Message</span><span>Call</span><span>When</span>
        </div>
        {data.length === 0 && <div className="empty">No errors logged. The voice service reports TTS, LLM and provider failures here.</div>}
        {data.map((e) => (
          <div key={e.id} className="row" style={{ gridTemplateColumns: "70px minmax(0,0.8fr) minmax(0,2fr) 100px 120px" }}>
            <span><span className={`badge ${BADGE[e.level] || ""}`}>{e.level}</span></span>
            <span className="code ellip">{e.source}</span>
            <span className="ellip" title={e.message}>{e.message}</span>
            <span className="muted ellip">{e.call_id ? e.call_id.slice(0, 8) : "—"}</span>
            <span className="muted">{e.at ? whenShort(e.at) : "—"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
