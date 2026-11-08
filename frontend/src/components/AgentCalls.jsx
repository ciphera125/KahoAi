// An agent's Call history: every call this agent has taken or made, newest first. Opening one
// shows the same dialog as the Calls page, so the recording and transcript are right here.
import { useEffect, useState } from "react";
import { get } from "../api.js";
import { serverView } from "../paginate.js";
import { dayWord } from "../time.js";
import CallDetail from "./CallDetail.jsx";
import { can, useMe } from "../auth.jsx";
import { fmtDur, Icon, OutcomePill, Pager, Spinner, useToast } from "../ui.jsx";

export default function AgentCalls({ agent }) {
  const toast = useToast();
  const me = useMe();
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let live = true;
    get(`/api/calls?agent_id=${agent.id}&page=${page}&per_page=${size}`)
      .then((d) => { if (live) setData(d); })
      .catch((e) => toast(e.message, true));
    return () => { live = false; };
  }, [agent.id, page, size, toast]);

  if (!data) return <Spinner />;
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }) : "");

  return (
    <div>
      <p className="hint" style={{ marginBottom: "var(--s3)" }}>
        Every call made by {agent.name}. Open one to read it, play the recording or download either.
      </p>
      <div className="card list">
        <div className="row head" style={{ gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) 70px 110px 240px" }}>
          <span>Person</span><span>When</span><span>Length</span><span>How it went</span><span />
        </div>
        {data.calls.length === 0 && <div className="empty">{agent.name} has not been on a call yet.</div>}
        {data.calls.map((c) => (
          <div key={c.call_id} className="row" style={{ gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) 70px 110px 240px" }}>
            <div style={{ minWidth: 0 }}>
              <button type="button" className="link ellip" onClick={() => setOpen(c)}>{c.contact_name || c.peer || "Unknown caller"}</button>
              {c.contact_name && <div className="muted ellip">{c.peer}</div>}
            </div>
            <span>{dayWord(c.started_at)}<span className="muted"> · {time(c.started_at)}</span></span>
            <span className="muted">{fmtDur(c.duration_secs)}</span>
            <span><OutcomePill status={c.status} /></span>
            <span className="row-buttons">
              {c.has_recording && can(me, "recordings.listen") && <button type="button" className="btn listen" onClick={() => setOpen(c)} title="Play the recording"><Icon name="play" />Listen</button>}
              {c.has_transcript && <a className="btn ghost" href={`/api/calls/${encodeURIComponent(c.call_id)}/transcript.csv`} download title="Download the transcript (opens in Excel or Google Sheets)"><Icon name="download" />Transcript</a>}
            </span>
          </div>
        ))}
      </div>
      <Pager view={serverView({ page, total: data.total, size })} size={size} onPage={setPage} onSize={(n) => { setSize(n); setPage(1); }} />
      {open && <CallDetail call={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
