import { can, useMe } from "../auth.jsx";
import { messages } from "../transcript.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, get, post } from "../api.js";
import { debounce } from "../debounce.js";
import { callsUrl } from "../recording.js";
import { serverView } from "../paginate.js";
import CallDetail from "../components/CallDetail.jsx";
import { fmtDur, Icon, initials, Modal, OutcomePill, Pager, plural, useToast, whenShort } from "../ui.jsx";

export default function Calls() {
  const toast = useToast();
  const me = useMe();
  const [agents, setAgents] = useState([]);
  const [numbers, setNumbers] = useState([]);
  const [watch, setWatch] = useState(null); // { uuid, label, sub }
  const [windowWarn, setWindowWarn] = useState(null);
  const [reload, setReload] = useState(0);

  const [languages, setLanguages] = useState([]);

  useEffect(() => {
    get("/api/agents").then(setAgents).catch(() => {});
    get("/api/numbers").then(setNumbers).catch(() => {});
    get("/api/config").then((c) => setLanguages(c.languages ?? [])).catch(() => {});
  }, []);

  const place = async ({ fromId, to, agentId, language }) => {
    try {
      const r = await post("/api/calls", { from_id: fromId, to, consent: true, agent_id: agentId || undefined,
        language: language || undefined });
      toast(`Ringing ${r.to}.`);
      if (r.request_uuid) setWatch({ uuid: r.request_uuid, label: r.to, sub: [r.to, r.agent_name].filter(Boolean).join(" · ") });
      setReload((n) => n + 1);
    } catch (e) {
      if (e instanceof ApiError && e.data.code === "outside_call_window") { setWindowWarn({ message: e.message, window: e.data.call_window }); return; }
      throw e;
    }
  };

  return (
    <section>
      <header className="page"><div><h1>Calls</h1><div className="sub">Call anyone with one of your agents, and follow the conversation live.</div></div></header>
      <div className="grid-side" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.15fr)" }}>
        <div className="stack">
          {can(me, "calls.place")
            ? <NewCall agents={agents} numbers={numbers} languages={languages} onPlace={place} />
            : <div className="card"><div className="card-head"><span className="card-title">New call</span></div>
              <p className="hint">Your role can look at calls but not place them. Ask an admin for a role that can.</p></div>}
          <History reload={reload} onWatch={setWatch} />
        </div>
        <LiveTranscript watch={watch} onEnded={() => setReload((n) => n + 1)} />
      </div>
      {windowWarn && (
        <Modal title="Outside the calling window" onClose={() => setWindowWarn(null)}>
          <p className="sub">{windowWarn.message}</p>
          {windowWarn.window && <p className="hint">This agent only calls between <b>{windowWarn.window.start}</b> and <b>{windowWarn.window.end}</b> ({windowWarn.window.timezone}).</p>}
          <div className="actions" style={{ justifyContent: "flex-end" }}><button className="primary" onClick={() => setWindowWarn(null)}>Got it</button></div>
        </Modal>
      )}
    </section>
  );
}

function NewCall({ agents, numbers, languages, onPlace }) {
  const toast = useToast();
  const [agentId, setAgentId] = useState("");
  const [fromId, setFromId] = useState("");
  const [language, setLanguage] = useState("");
  const [to, setTo] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState([]);
  const active = numbers.filter((n) => n.status === "active");
  useEffect(() => { if (!fromId && active[0]) setFromId((numbers.find((n) => n.is_default && n.status === "active") || active[0]).id); }, [numbers]);

  useEffect(() => {
    if (to.trim().length < 2) { setMatches([]); return undefined; }
    const t = setTimeout(() => get(`/api/contacts/lookup?q=${encodeURIComponent(to.trim())}`).then(setMatches).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [to]);

  const go = async () => {
    if (!to.trim()) return toast("Type a number to call.", true);
    if (!consent) return toast("Confirm that this person agreed to be called.", true);
    setBusy(true);
    try { await onPlace({ fromId, to: to.trim(), agentId, language }); setTo(""); setConsent(false); }
    catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-head"><span className="card-title">New call</span></div>
      <div className="field"><label className="f">Agent</label>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Default persona (no agent)</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <div className="field"><label className="f">Language on this call</label>
        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="">Whatever the agent is set to</option>
          {languages.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
        <span className="hint">{languages.find((l) => l.value === language)?.hint
          ?? "Leave it to use the language set on the agent."}</span>
      </div>
      <div className="field"><label className="f">Call from</label>
        <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
          {numbers.length === 0 && <option value="">No numbers yet, add one on Numbers</option>}
          {numbers.map((n) => <option key={n.id} value={n.id} disabled={n.status !== "active"}>{n.number} · {n.provider_label}{n.status !== "active" ? " (not ready)" : ""}</option>)}
        </select>
      </div>
      <div className="field"><label className="f">Number to call</label>
        <input list="contact-matches" type="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder="98765 43210 or a contact's number" autoComplete="off" />
        <datalist id="contact-matches">{matches.map((m) => <option key={m.number} value={m.number}>{m.name}</option>)}</datalist>
      </div>
      <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>This person has agreed to be called. India's TRAI/DND rules apply, and the call is recorded.</span></label>
      <div className="actions"><button className="primary xl" onClick={go} disabled={busy}><Icon name="call" />Call now</button></div>
    </div>
  );
}

function History({ reload, onWatch }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [view, setView] = useState(null);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const applyQuery = useMemo(() => debounce((v) => { setQ(v); setPage(1); }, 300), []);
  useEffect(() => () => applyQuery.cancel(), [applyQuery]);
  useEffect(() => {
    let live = true;
    get(callsUrl({ page, perPage: size, q })).then((d) => { if (live) setData(d); }).catch(() => {});
    return () => { live = false; };
  }, [page, size, reload, q]);
  return (
    <div className="card">
      <div className="card-head"><span className="card-title">Call history</span><span className="muted">{data ? plural(data.total, "call") : ""}</span></div>
      <div className="call-search">
        <Icon name="search" />
        <input type="search" value={text} maxLength={100} placeholder="Search transcripts and summaries" aria-label="Search transcripts and summaries"
          onChange={(e) => { setText(e.target.value); applyQuery(e.target.value); }} />
        {text && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => { setText(""); applyQuery.cancel(); setQ(""); setPage(1); }}><Icon name="x" /></button>}
      </div>
      {data?.calls.length === 0 && <div className="hint">{q.trim() ? "No calls match" : "No calls yet."}</div>}
      {data?.calls.map((c) => (
        <button key={c.call_id} type="button" className="call-row"
          onClick={() => (c.has_transcript ? setView(c) : c.status === "ringing" ? onWatch({ uuid: c.call_id, label: c.contact_name || c.peer || "Call", sub: c.peer }) : null)}>
          <div style={{ minWidth: 0, textAlign: "left" }}>
            <b className="ellip">{c.contact_name || c.peer || "Unknown number"}</b>
            <div className="muted ellip">{[whenShort(c.started_at), c.agent_name, c.status === "answered" ? fmtDur(c.duration_secs) : null].filter(Boolean).join(" · ")}</div>
          </div>
          <span className="call-meta">{c.has_recording && <span className="rec-badge" title="This call was recorded"><Icon name="mic" />Recording</span>}<OutcomePill status={c.status} />{c.sentiment && <span className={`mood ${c.sentiment}`} title={`The caller left ${c.sentiment === "positive" ? "happy" : c.sentiment === "negative" ? "unhappy" : "neutral"}`}>{c.sentiment === "positive" ? "Happy" : c.sentiment === "negative" ? "Unhappy" : "Neutral"}</span>}</span>
        </button>
      ))}
      {data && <Pager view={serverView({ page, total: data.total, size })} size={size} onPage={setPage} onSize={(n) => { setSize(n); setPage(1); }} />}
      {view && <CallDetail call={view} onClose={() => setView(null)} />}
    </div>
  );
}

function LiveTranscript({ watch, onEnded }) {
  const [events, setEvents] = useState([]);
  const [state, setState] = useState("Idle");
  const boxRef = useRef();
  const endedRef = useRef(onEnded);
  useEffect(() => { endedRef.current = onEnded; }, [onEnded]);

  useEffect(() => {
    if (!watch) return undefined;
    setEvents([]); setState("Ringing");
    const src = new EventSource(`/api/calls/${encodeURIComponent(watch.uuid)}/stream`);
    src.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.event === "call_start") setState("Live");
      else if (e.event === "no_answer") { setState("Not picked up"); src.close(); }
      else if (e.event === "call_end") { setState("Ended"); src.close(); endedRef.current?.(); }
      setEvents((list) => [...list, e]);
    };
    src.onerror = () => { if (src.readyState === EventSource.CLOSED) setState("Disconnected"); };
    return () => src.close();
  }, [watch?.uuid]);

  useEffect(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }, [events]);

  const TOOL = { capture_lead: "Details saved", end_call: "The agent ended the call", transfer_to_human: "Transferred to a person", call_webhook: "Checked your system" };
  return (
    <div className="card chat-card">
      <div className="chat-head">
        <div className="who"><div className="avatar">{watch ? (watch.label.startsWith("+") ? "#" : initials(watch.label)) : "K"}</div>
          <div style={{ minWidth: 0 }}><b className="ellip">{watch ? watch.label : "Live transcript"}</b><div className="muted ellip">{watch ? watch.sub : "Start a call to see it here"}</div></div>
        </div>
        <span className={`pill ${state === "Live" ? "live" : state === "Ringing" ? "ringing" : "muted"}`}>{state}</span>
      </div>
      <div className="chat" ref={boxRef}>
        {events.length === 0 && <div className="center" style={{ margin: "auto", color: "var(--text-3)" }}><Icon name="chat" /><span style={{ marginLeft: 8 }}>The agent on the left, the person on the right.</span></div>}
        {messages(events).map((e, i) => {
          if (e.event === "turn" || e.event === "live") return <div key={i} className={`msg ${e.role === "agent" ? "agent" : "caller"}`}>{e.text}</div>;
          if (e.event === "tool") return <div key={i} className="sys">{TOOL[e.name] || e.name}</div>;
          if (e.event === "tool_rejected") return <div key={i} className="sys warn-line">The agent tried to use a tool it does not have{e.name && e.name !== "unknown" ? ` (${e.name})` : ""}; it answered in words instead</div>;
          if (e.event === "recording_notice_played") return <div key={i} className="sys">Recording notice played</div>;
          if (e.event === "call_failed") return <div key={i} className="sys">A provider failed during the call</div>;
          if (e.event === "no_answer") return <div key={i} className="sys">Not picked up</div>;
          if (e.event === "call_end") return <div key={i} className="sys">Call ended</div>;
          return null;
        })}
      </div>
    </div>
  );
}
