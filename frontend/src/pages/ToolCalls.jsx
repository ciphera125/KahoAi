// Tool calls: everything the agents did on calls, said plainly. Each one shows what it came to (worked,
// needed the caller, stopped by a safety check, failed, not switched on), one line on what happened, and
// what you can do about it when there is something to do. The raw request and reply are behind a switch.
import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "../api.js";
import CallDetail from "../components/CallDetail.jsx";
import { serverView } from "../paginate.js";
import { pillClass, RESULT_FILTERS, toolCallsUrl } from "../toolCalls.js";
import { Icon, Info, Pager, Spinner, useToast, whenShort } from "../ui.jsx";

const TILE_HELP = {
  "Tool calls": "How many times agents pressed a tool, across everything that matches your filters. Press a tile to show only those.",
  Worked: "The tool did its job, for example the details were saved or the task was added.",
  "Need your attention": "Something broke (your system did not answer, a tool failed) or the agent tried a tool it was never given. These are the ones to look at.",
  "Held back on purpose": "Nothing is broken. The agent still needed something from the caller, such as a clear date, or a safety check stopped it, for example from hanging up before a goodbye.",
  "Not recorded": "Older calls that did not save whether the tool worked.",
};
const BLANK = { outcome: "", tool: "", agent_id: "", from: "", to: "" };

export default function ToolCalls() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [filters, setFilters] = useState(BLANK);
  const [person, setPerson] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [technical, setTechnical] = useState(false);
  const [opened, setOpened] = useState(null);

  const [contact, setContact] = useState("");
  // A changed filter starts again at page 1, in the same update, so only one request goes out for it.
  const set = (patch) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };
  // Typing a name waits for a pause, so the history is not asked again on every key.
  useEffect(() => {
    const t = setTimeout(() => { setContact(person.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [person]);

  // Only the newest answer is shown: an older, slower one must not land on top of it.
  const latest = useRef(0);
  const load = useCallback(() => {
    const mine = ++latest.current;
    get(toolCallsUrl({ ...filters, contact }, page, size))
      .then((d) => { if (mine === latest.current) setData(d); })
      .catch((e) => { if (mine === latest.current) toast(e.message, true); });
  }, [filters, contact, page, size, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { get("/api/agents").then(setAgents).catch(() => {}); }, []);

  const filtered = Object.values(filters).some(Boolean) || Boolean(contact);
  const open = async (callId) => {
    try { setOpened(await get(`/api/calls/${encodeURIComponent(callId)}`)); } catch (e) { toast(e.message, true); }
  };

  return (
    <section>
      <header className="page">
        <div><h1>Tool calls<Info text="A tool is a button the agent can press during a call, like saving the caller's details or adding a task. This page is the receipt for every press: what the agent did, whether it worked, and why not when it did not." /></h1>
          <div className="sub">Everything your agents did on calls, like saving details or adding a task, and whether it worked. To give an agent a tool, go to Agents, then Tools.</div></div>
        <div className="head-actions">
          <label className="switch-inline">
            <input type="checkbox" checked={technical} onChange={(e) => setTechnical(e.target.checked)} />
            Show technical details<Info text="Adds the exact request the agent sent and the answer it got back. Useful for a developer; most people can leave it off." />
          </label>
        </div>
      </header>

      {data && <Summary summary={data.summary} active={filters.outcome} onPick={(outcome) => set({ outcome: filters.outcome === outcome ? "" : outcome })} />}

      <div className="card" style={{ marginBottom: "var(--s3)" }}>
        <div className="q-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 0 }}>
          <div className="field"><label className="f" htmlFor="tc-result">Result<Info text="Needs your attention: something broke or the tool was not switched on. Held back on purpose: the agent waited for the caller, or a safety check stopped it. Nothing for you to fix." /></label>
            <select id="tc-result" value={filters.outcome} onChange={(e) => set({ outcome: e.target.value })}>
              {RESULT_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          <div className="field"><label className="f" htmlFor="tc-agent">Agent<Info text="Show only calls answered by this agent." /></label>
            <select id="tc-agent" value={filters.agent_id} onChange={(e) => set({ agent_id: e.target.value })}>
              <option value="">Any agent</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></div>
          <div className="field"><label className="f" htmlFor="tc-tool">Tool<Info text="Show only one kind of tool, for example Save details." /></label>
            <select id="tc-tool" value={filters.tool} onChange={(e) => set({ tool: e.target.value })}>
              <option value="">Any tool</option>
              {(data?.tools ?? []).map((t) => <option key={t.name} value={t.name}>{t.label}</option>)}
            </select></div>
          <div className="field"><label className="f" htmlFor="tc-person">Person<Info text="Type part of a name or phone number, in any format, to see what the agents did on that person's calls." /></label>
            <input id="tc-person" value={person} maxLength={100} placeholder="Name or number" onChange={(e) => setPerson(e.target.value)} /></div>
          <div className="field"><label className="f" htmlFor="tc-from">From<Info text="First day to show, by India's calendar." /></label>
            <input id="tc-from" type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></div>
          <div className="field"><label className="f" htmlFor="tc-to">To<Info text="Last day to show, by India's calendar." /></label>
            <input id="tc-to" type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></div>
        </div>
        {filtered && <div className="actions" style={{ marginTop: "var(--s2)" }}>
          <button type="button" className="ghost" onClick={() => { setFilters(BLANK); setPerson(""); setContact(""); setPage(1); }}><Icon name="x" />Clear filters</button></div>}
      </div>

      {!data && <Spinner />}
      {data?.calls.length === 0 && <div className="card"><p className="hint">
        {filtered ? "No tool calls match these filters." : "Nothing here yet. This fills up as your agents use tools on calls."}</p></div>}
      {data?.calls.map((call) => <CallNode key={call.call_id} call={call} technical={technical} onOpen={() => open(call.call_id)} />)}
      {data && data.calls_total > 0 && (
        <Pager view={serverView({ page: data.page, total: data.calls_total, size: data.per_page })} size={data.per_page}
          onPage={setPage} onSize={(n) => { setSize(n); setPage(1); }} />
      )}
      {opened && <CallDetail call={opened} onClose={() => setOpened(null)} />}
    </section>
  );
}

/** The counts at the top, for everything that matches. Pressing one shows only those. */
function Summary({ summary, active, onPick }) {
  if (!summary || summary.total === 0) return null;
  const tiles = [
    ["", "Tool calls", summary.total, "tool"],
    ["worked", "Worked", summary.worked, "check"],
    ["attention", "Need your attention", summary.attention, "warn"],
    ["held", "Held back on purpose", summary.held, "clock"],
    ...(summary.unknown ? [["unknown", "Not recorded", summary.unknown, "help"]] : []),
  ];
  return (
    <>
      <div className="kpis tool-kpis">
        {tiles.map(([key, label, n, icon]) => (
          <button key={label} type="button" className={`kpi kpi-btn${key && active === key ? " on" : ""}${key === "attention" && n ? " attention" : ""}`}
            onClick={() => onPick(key)} aria-pressed={key ? active === key : undefined} title={key ? `Show only: ${label.toLowerCase()}` : "Show every result"}>
            <span className="kpi-icon"><Icon name={icon} /></span>
            <span className="k">{label}{TILE_HELP[label] && <Info text={TILE_HELP[label]} />}</span><span className="v">{n.toLocaleString("en-IN")}</span>
          </button>
        ))}
      </div>
      {summary.by_tool.length > 1 && (
        <details className="card by-tool" style={{ marginBottom: "var(--s3)" }}>
          <summary><b>By tool</b><Info text="Each tool, how often it was used and how it went, for everything that matches your filters." /> <span className="hint">how often each one was used, and how it went</span></summary>
          <table className="rows"><thead><tr><th>Tool</th><th>Used</th><th>Worked</th><th>Need your attention</th><th>Held back</th></tr></thead>
            <tbody>{summary.by_tool.map((t) => (
              <tr key={t.name}><td>{t.label}</td><td>{t.total}</td><td>{t.worked}</td>
                <td>{t.attention ? <span className="pill failed">{t.attention}</span> : 0}</td><td>{t.held}</td></tr>))}</tbody></table>
        </details>
      )}
    </>
  );
}

function CallNode({ call, technical, onOpen }) {
  const [open, setOpen] = useState(true);
  const all = call.turns.flatMap((t) => t.calls);
  const attention = all.filter((c) => c.attention).length;
  return (
    <div className="card" style={{ marginBottom: "var(--s3)" }}>
      <div className="tree-head-row">
        <button type="button" className="tree-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className={`twist${open ? " open" : ""}`}><Icon name="chevron" /></span>
          <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
            <div className="call-badges">
              <span className="badge person" title="Who the call was with"><Icon name="contacts" />{call.contact_name || "Not in your contacts"}</span>
              {call.peer && <span className="badge" title="Their number"><Icon name="call" />{call.peer}</span>}
              {call.agent_name && <span className="badge" title="The agent that took the call"><Icon name="agent" />{call.agent_name}</span>}
              {call.agent_version && <span className="badge" title="Which published version of the agent answered">Version {call.agent_version}</span>}
              {call.started_at && <span className="badge" title="When the call started (India time)"><Icon name="clock" />{whenShort(call.started_at)}</span>}
              <span className="badge" title="How many times the agent used a tool on this call"><Icon name="tool" />{all.length} tool call{all.length === 1 ? "" : "s"}</span>
              {attention > 0 && <span className="badge bad" title="Tool calls on this call that need you to look"><Icon name="warn" />{attention} need{attention === 1 ? "s" : ""} your attention</span>}
            </div>
          </div>
        </button>
        <button type="button" className="ghost small-btn" onClick={onOpen}><Icon name="chat" />Open call<Info text="Opens the whole call: the recording, the written conversation, and these tool calls in the place they happened." /></button>
      </div>
      {open && call.tools_available && (
        <div className="hint tools-had">Tools it had on this call<Info text="The tools switched on for this agent when the call happened. If a tool you expected is missing, switch it on under Agents, then Tools, and publish." />: {call.tools_available.length
          ? call.tools_available.map((t) => t.label).join(", ") : "none"}</div>
      )}
      {open && call.turns.map((turn, i) => (
        <div key={i} className="tree-turn">
          <div className="hint tree-said">{turn.said ? <>After they said “{turn.said}”</> : "Before the caller spoke"}</div>
          {turn.calls.map((c) => <ToolNode key={c.id} call={c} technical={technical} />)}
        </div>
      ))}
    </div>
  );
}

function ToolNode({ call, technical }) {
  return (
    <div className={`tree-tool ${call.attention ? "attention" : call.outcome === "worked" ? "worked" : "held"}`}>
      <div className="tree-tool-head">
        <b>{call.label}</b>
        <span className={`pill ${pillClass(call.outcome)}`}>{call.outcome_label}</span>
        {call.secs !== null && <span className="hint">{call.secs}s</span>}
      </div>
      <div>{call.summary}</div>
      {call.why && <div className="hint"><b>Why:</b> {call.why}</div>}
      {call.fix && <div className="hint fix-line"><b>What you can do:</b> {call.fix}</div>}
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
