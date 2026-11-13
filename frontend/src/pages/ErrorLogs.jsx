// Problems the voice service reported. Two lists: the ones nobody has dealt with (opens here)
// and the ones somebody has acknowledged. Tick several to move them together, either way.
import { useCallback, useEffect, useState } from "react";
import { get, post } from "../api.js";
import { can, useMe } from "../auth.jsx";
import { Icon, Spinner, usePaged, useToast, whenShort } from "../ui.jsx";

const BADGE = { error: "bad", warn: "warn" };
const COLS = "32px 70px minmax(0,0.8fr) minmax(0,2fr) 90px 120px 130px";

export default function ErrorLogs() {
  const me = useMe();
  const toast = useToast();
  const [tab, setTab] = useState("open");
  const [data, setData] = useState(null);
  const [counts, setCounts] = useState({ open: 0, acknowledged: 0 });
  const [picked, setPicked] = useState(() => new Set());
  const canAck = can(me, "agents.edit");

  const load = useCallback(() => get(`/api/errors?limit=200&status=${tab}`).then((r) => {
    setData(r.errors); setCounts(r.counts); setPicked(new Set());
  }).catch((e) => toast(e.message, true)), [tab, toast]);
  useEffect(() => { setData(null); load(); }, [load]);
  const [shown, pager] = usePaged(data ?? []);

  const move = async (ids) => {
    const acknowledged = tab === "open";
    try {
      const r = await post("/api/errors/acknowledge", { ids, acknowledged });
      toast(`${r.changed} ${r.changed === 1 ? "error" : "errors"} ${acknowledged ? "acknowledged" : "moved back to Open"}.`);
      load();
    } catch (e) { toast(e.message, true); }
  };
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOnPage = shown.length > 0 && shown.every((e) => picked.has(e.id));
  const toggleAll = () => setPicked((p) => { const n = new Set(p); shown.forEach((e) => (allOnPage ? n.delete(e.id) : n.add(e.id))); return n; });
  const verb = tab === "open" ? "Acknowledge" : "Move back to Open";

  return (
    <section>
      <header className="page">
        <div><h1>Error Logs</h1><div className="sub">Problems the phone system ran into during calls, such as a voice or the AI not answering. When you have looked at one, press Acknowledge and it moves to the Acknowledged tab.</div></div>
        <div className="head-actions"><button className="ghost" onClick={load}><Icon name="refresh" />Refresh</button></div>
      </header>
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === "open"} className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>Open <span className="count">{counts.open}</span></button>
        <button role="tab" aria-selected={tab === "acknowledged"} className={tab === "acknowledged" ? "on" : ""} onClick={() => setTab("acknowledged")}>Acknowledged <span className="count">{counts.acknowledged}</span></button>
      </div>
      {canAck && picked.size > 0 && (
        <div className="bulkbar" role="status">
          <b>{picked.size} selected</b>
          <button className="primary small-btn" onClick={() => move([...picked])}>{verb} {picked.size === 1 ? "this one" : `these ${picked.size}`}</button>
          <button className="ghost small-btn" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
      {!data ? <Spinner /> : (
        <div className="card list">
          <div className="row head" style={{ gridTemplateColumns: COLS }}>
            <span>{canAck && <input type="checkbox" checked={allOnPage} onChange={toggleAll} aria-label="Select all on this page" />}</span>
            <span>Level</span><span>Source</span><span>What happened</span><span>Call</span><span>When</span><span>{tab === "open" ? "Action" : "Acknowledged by"}</span>
          </div>
          {data.length === 0 && <div className="empty">{tab === "open" ? "Nothing needs your attention. New problems from the phone system show up here." : "Nothing acknowledged yet."}</div>}
          {shown.map((e) => (
            <div key={e.id} className="row" style={{ gridTemplateColumns: COLS }}>
              <span>{canAck && <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} aria-label="Select this error" />}</span>
              <span><span className={`badge ${BADGE[e.level] || ""}`}>{e.level}</span></span>
              <span className="code ellip">{e.source}</span>
              <span className="ellip" title={e.message}>{e.message}</span>
              <span className="muted ellip">{e.call_id ? e.call_id.slice(0, 8) : "-"}</span>
              <span className="muted">{e.at ? whenShort(e.at) : "-"}</span>
              {tab === "open"
                ? <span>{canAck && <button className="ghost small-btn ack-btn" onClick={() => move([e.id])}><Icon name="check" />Acknowledge</button>}</span>
                : <span className="muted ellip" title={e.acknowledged_at ? whenShort(e.acknowledged_at) : ""}>{e.acknowledged_by || "-"}{canAck && <button className="link small-btn" onClick={() => move([e.id])} style={{ marginLeft: 8 }}>Undo</button>}</span>}
            </div>
          ))}
        </div>
      )}
      {pager}
    </section>
  );
}
