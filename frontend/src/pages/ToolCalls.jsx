import { useEffect, useMemo, useState } from "react";
import { get } from "../api.js";
import { Icon, Modal, Spinner, useToast, whenShort } from "../ui.jsx";

export default function ToolCalls() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [tool, setTool] = useState("");
  const [view, setView] = useState(null);
  useEffect(() => { get("/api/calls/tools?limit=100").then(setData).catch((e) => toast(e.message, true)); }, []);
  const tools = useMemo(() => [...new Set((data || []).map((t) => t.tool))].sort(), [data]);
  if (!data) return <Spinner />;

  const rows = tool ? data.filter((t) => t.tool === tool) : data;

  return (
    <section>
      <header className="page">
        <div><h1>Tool Calls</h1><div className="sub">Every tool an agent invoked during a call.</div></div>
        {tools.length > 0 && (
          <div className="head-actions">
            <select value={tool} onChange={(e) => setTool(e.target.value)} style={{ width: 180 }}>
              <option value="">All tools</option>
              {tools.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        )}
      </header>
      <div className="card list">
        <div className="row head" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 120px" }}>
          <span>Tool</span><span>Call</span><span>Contact</span><span>When</span>
        </div>
        {rows.length === 0 && <div className="empty">No tool calls yet. Agents call tools like end_call, capture_lead and transfer_to_human during conversations.</div>}
        {rows.map((t) => (
          <div key={t.id} className="row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 120px" }}>
            <span className="code">{t.tool}</span>
            <button type="button" className="link ellip" onClick={() => setView(t)}>{t.call_id}</button>
            <span className="ellip">{t.peer || "—"}</span>
            <span className="muted">{t.at ? whenShort(t.at) : "—"}</span>
          </div>
        ))}
      </div>
      {view && <ToolCallCall callId={view.call_id} peer={view.peer} onClose={() => setView(null)} />}
    </section>
  );
}

/** The transcript around a tool call, not the tool's own arguments or result:
 * those are never stored (they can carry the caller's PII), only its name. */
function ToolCallCall({ callId, peer, onClose }) {
  const [turns, setTurns] = useState(null);
  useEffect(() => { get(`/api/calls/${encodeURIComponent(callId)}/transcript`).then(setTurns).catch(() => setTurns([])); }, [callId]);
  return (
    <Modal title={peer || "Call"} onClose={onClose} wide>
      <div className="chat" style={{ maxHeight: "60vh", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
        {!turns && <div className="hint">Loading…</div>}
        {turns && turns.length === 0 && <div className="hint">Nothing was said on this call.</div>}
        {turns?.map((t, i) => <div key={i} className={`msg ${t.role}`}>{t.text}<time>{t.at ? new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</time></div>)}
      </div>
      <div className="actions"><a className="ghost" href={`/api/calls/${encodeURIComponent(callId)}/transcript.csv`} download><Icon name="download" />Download CSV</a></div>
    </Modal>
  );
}
