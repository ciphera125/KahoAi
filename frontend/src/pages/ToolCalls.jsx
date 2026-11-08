import { useCallback, useEffect, useMemo, useState } from "react";
import { get } from "../api.js";
import { Icon, Spinner, usePaged, useToast, whenShort } from "../ui.jsx";

const STATUS_WORDS = { worked: "Worked", failed: "Did not work", refused: "Not one of its tools" };

/**
 * What the agents actually did, as a tree: a call, the turns in it, and the tools used
 * on each turn. The plain reading comes first; the raw request and reply sit behind a
 * toggle, because almost nobody needs them and they are noisy.
 */
export default function ToolCalls({ embedded = false }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [filters, setFilters] = useState({ tool: "", status: "", agent_id: "", contact: "", from: "", to: "" });
  const [technical, setTechnical] = useState(false);

  const query = useMemo(() => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) q.set(key, value);
    return q.toString();
  }, [filters]);

  const load = useCallback(() => {
    get(`/api/calls/tools${query ? `?${query}` : ""}`).then(setData).catch((e) => toast(e.message, true));
  }, [query, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { get("/api/agents").then(setAgents).catch(() => {}); }, []);
  const [shownCalls, callPager] = usePaged(data?.calls ?? [], 10);

  const tools = useMemo(() => [...new Set(
    (data?.calls ?? []).flatMap((c) => c.turns.flatMap((t) => t.calls.map((x) => x.tool))))].sort(), [data]);
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <section>
      {embedded ? (
        <div className="list-bar" style={{ marginBottom: "var(--s3)" }}>
          <span className="hint">Every time an agent used a tool on a call, and whether it worked.</span>
          <span className="grow" />
          <label className="switch-inline">
            <input type="checkbox" checked={technical} onChange={(e) => setTechnical(e.target.checked)} />
            Show technical details
          </label>
        </div>
      ) : (
      <header className="page">
        <div><h1>Tool history</h1><div className="sub">A record of every time an agent used a tool on a call, and whether it worked. To give an agent a tool, go to Agents, then Tools.</div></div>
        <div className="head-actions">
          <label className="switch-inline">
            <input type="checkbox" checked={technical} onChange={(e) => setTechnical(e.target.checked)} />
            Show technical details
          </label>
        </div>
      </header>
      )}

      <div className="card" style={{ marginBottom: "var(--s3)" }}>
        <div className="q-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 0 }}>
          <div className="field"><label className="f">Agent</label>
            <select value={filters.agent_id} onChange={(e) => set({ agent_id: e.target.value })}>
              <option value="">Any agent</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></div>
          <div className="field"><label className="f">Tool</label>
            <select value={filters.tool} onChange={(e) => set({ tool: e.target.value })}>
              <option value="">Any tool</option>
              {tools.map((t) => <option key={t} value={t}>{t}</option>)}
            </select></div>
          <div className="field"><label className="f">How it went</label>
            <select value={filters.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Either way</option>
              <option value="worked">Worked</option>
              <option value="failed">Did not work</option>
            </select></div>
          <div className="field"><label className="f">Person</label>
            <input value={filters.contact} placeholder="Name or number" onChange={(e) => set({ contact: e.target.value })} /></div>
          <div className="field"><label className="f">From</label>
            <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></div>
          <div className="field"><label className="f">To</label>
            <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></div>
        </div>
      </div>

      {!data && <Spinner />}
      {data?.calls.length === 0 && <div className="card"><p className="hint">
        Nothing here yet. This fills up as agents use tools on calls.</p></div>}
      {shownCalls.map((call) => <CallNode key={call.call_id} call={call} technical={technical} />)}
      {data && data.calls.length > 0 && callPager}
    </section>
  );
}

function CallNode({ call, technical }) {
  const [open, setOpen] = useState(true);
  const counts = call.turns.flatMap((t) => t.calls);
  const failed = counts.filter((c) => c.status !== "worked").length;
  return (
    <div className="card" style={{ marginBottom: "var(--s3)" }}>
      <button className="tree-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`twist${open ? " open" : ""}`}><Icon name="chevron" /></span>
        <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
          <b>{call.contact_name || call.peer || "Unknown caller"}</b>
          <div className="hint">
            {[call.agent_name && `${call.agent_name}${call.agent_version ? ` v${call.agent_version}` : ""}`,
              call.started_at && whenShort(call.started_at),
              `${counts.length} tool call${counts.length === 1 ? "" : "s"}`,
              failed ? `${failed} did not work` : null].filter(Boolean).join(" · ")}
          </div>
        </div>
      </button>
      {open && call.turns.map((turn, i) => (
        <div key={i} className="tree-turn">
          <div className="hint tree-said">
            {turn.turn ? <>Turn {turn.turn}{turn.said ? <>, they said “{turn.said}”</> : null}</> : "Outside any turn"}
          </div>
          {turn.calls.map((c) => <ToolNode key={c.id} call={c} technical={technical} />)}
        </div>
      ))}
    </div>
  );
}

function ToolNode({ call, technical }) {
  return (
    <div className={`tree-tool ${call.status}`}>
      <div className="tree-tool-head">
        <b>{call.label}</b>
        <span className={`pill ${call.status === "worked" ? "live" : "muted"}`}>{STATUS_WORDS[call.status]}</span>
        {call.secs !== null && <span className="hint">{call.secs}s</span>}
      </div>
      {call.why && <div className="hint">{call.why}</div>}
      {technical && (
        <div className="answers" style={{ marginTop: 6 }}>
          <div className="answer-line"><span className="muted">Tool</span><code>{call.tool}</code></div>
          {call.sent && <div className="answer-line"><span className="muted">Sent</span><code>{JSON.stringify(call.sent)}</code></div>}
          {call.answer && <div className="answer-line"><span className="muted">Answer</span><code>{JSON.stringify(call.answer)}</code></div>}
          {call.detail && <div className="answer-line"><span className="muted">Error</span><code>{call.detail}</code></div>}
        </div>
      )}
    </div>
  );
}
