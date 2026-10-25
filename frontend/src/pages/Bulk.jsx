// Bulk calls: upload a list (CSV) of names and numbers, pick an agent, and the
// server calls them a few at a time. The list page shows every run; a run's
// page shows each person and how their call went, refreshing while it runs.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { get, post } from "../api.js";
import { parseCallList } from "../csv.js";
import { Icon, Modal, OutcomePill, plural, Spinner, useConfirm, useToast, whenShort } from "../ui.jsx";

const STATUS_LABEL = { running: "Running", paused: "Paused", done: "Finished", cancelled: "Cancelled" };
const ITEM_LABEL = { queued: "Waiting", dialling: "Dialling", calling: "On a call", done: "Done", skipped: "Skipped", failed: "Failed" };
const SAMPLE = "name,phone\nAsha Rao,98765 43210\nRavi Kumar,+91 91234 56789\n";

const people = (n) => `${(n ?? 0).toLocaleString()} ${n === 1 ? "person" : "people"}`;
const progress = (c) => (c.total ? Math.round(((c.done + c.skipped + c.failed) / c.total) * 100) : 0);

export default function Bulk() {
  const { runId } = useParams();
  return runId ? <RunDetail id={runId} /> : <RunList />;
}

function RunList() {
  const toast = useToast();
  const navigate = useNavigate();
  const [runs, setRuns] = useState(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => get("/api/bulk-calls").then(setRuns).catch((e) => toast(e.message, true)), [toast]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  return (
    <section>
      <header className="page">
        <div><h1>Bulk calls</h1><div className="sub">Upload a list of names and phone numbers and an agent calls them all, a few at a time. Do not call numbers are skipped.</div></div>
        <div className="head-actions"><button className="primary" onClick={() => setCreating(true)}><Icon name="upload" />New bulk call</button></div>
      </header>
      <div className="card list">
        <div className="row head bulk-cols"><span>Name</span><span>Agent</span><span>Progress</span><span>Status</span><span>Started</span></div>
        {!runs && <Spinner />}
        {runs?.length === 0 && (
          <div className="empty">
            <p>No bulk calls yet.</p>
            <button className="primary" onClick={() => setCreating(true)}><Icon name="upload" />Upload a list</button>
          </div>
        )}
        {runs?.map((r) => (
          <button type="button" key={r.id} className="row bulk-cols row-link" onClick={() => navigate(`/bulk/${r.id}`)}>
            <b className="ellip">{r.name}</b>
            <span className="ellip">{r.agent_name || <span className="muted">Agent deleted</span>}</span>
            <span className="prog"><span className="meter"><i style={{ width: `${progress(r.counts)}%` }} /></span><span className="muted num">{r.counts.done + r.counts.skipped + r.counts.failed}/{r.counts.total}</span></span>
            <span><span className={`pill ${r.status === "running" ? "live" : r.status === "paused" ? "warn" : "muted"}`}>{STATUS_LABEL[r.status]}</span></span>
            <span className="muted">{whenShort(r.created_at)}</span>
          </button>
        ))}
      </div>
      {creating && <NewRun onClose={() => setCreating(false)} onStarted={(run) => navigate(`/bulk/${run.id}`)} />}
    </section>
  );
}

function NewRun({ onClose, onStarted }) {
  const toast = useToast();
  const fileRef = useRef();
  const [agents, setAgents] = useState([]);
  const [numbers, setNumbers] = useState([]);
  const [list, setList] = useState(null); // { file, rows }
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [fromId, setFromId] = useState("");
  const [parallel, setParallel] = useState(3);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    get("/api/agents").then((a) => { setAgents(a); if (a[0]) setAgentId((v) => v || a[0].id); }).catch(() => {});
    get("/api/numbers").then((n) => {
      setNumbers(n);
      const pick = n.find((x) => x.is_default && x.status === "active") || n.find((x) => x.status === "active");
      if (pick) setFromId((v) => v || pick.id);
    }).catch(() => {});
  }, []);

  const read = async (file) => {
    if (!file) return;
    if (file.size > 2_000_000) return toast("That file is over 2 MB. Split it into smaller lists.", true);
    try {
      const { rows } = parseCallList(await file.text());
      if (rows.length > 5000) return toast(`That list has ${rows.length.toLocaleString()} rows; at most 5,000 at a time.`, true);
      setList({ file: file.name, rows });
      if (!name) setName(file.name.replace(/\.(csv|txt|tsv)$/i, "").slice(0, 80));
    } catch (e) { toast(e.message, true); }
  };

  const start = async () => {
    if (!list) return toast("Choose a file first.", true);
    if (!agentId) return toast("Choose an agent.", true);
    if (!consent) return toast("Confirm that everyone on the list agreed to be called.", true);
    setBusy(true);
    try {
      const run = await post("/api/bulk-calls", { name, agent_id: agentId, from_id: fromId, parallel: Number(parallel), rows: list.rows, consent: true });
      toast(`Started: ${people(run.counts.queued)} to call${run.counts.skipped ? `, ${run.counts.skipped} skipped` : ""}.`);
      onStarted(run);
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  const sampleHref = `data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE)}`;
  return (
    <Modal title="New bulk call" onClose={onClose} wide>
      <div className={`drop${drag ? " on" : ""}${list ? " done" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); read(e.dataTransfer.files[0]); }}
        onClick={() => fileRef.current.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && fileRef.current.click()}>
        <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,text/csv" hidden onChange={(e) => read(e.target.files[0])} />
        <Icon name="upload" />
        {list ? <div><b>{list.file}</b><div className="muted">{plural(list.rows.length, "row")} read · click to choose another file</div></div>
          : <div><b>Drop a CSV file here, or click to choose one</b><div className="muted">Two columns: a name and a phone number. A header row is optional.</div></div>}
      </div>
      <div className="hint" style={{ margin: "6px 0 var(--s4)" }}>From Excel or Google Sheets: File → Download → CSV. <a href={sampleHref} download="kaho-call-list-sample.csv" onClick={(e) => e.stopPropagation()}>Download a sample</a></div>

      {list && (
        <div className="preview">
          <div className="row head" style={{ gridTemplateColumns: "40px minmax(0,1fr) minmax(0,1fr)" }}><span>#</span><span>Name</span><span>Number</span></div>
          {list.rows.slice(0, 5).map((r, i) => (
            <div key={i} className="row" style={{ gridTemplateColumns: "40px minmax(0,1fr) minmax(0,1fr)", minHeight: 36 }}>
              <span className="muted num">{i + 1}</span><span className="ellip">{r.name || <span className="muted">—</span>}</span><span className="num ellip">{r.number || <span className="muted">missing</span>}</span>
            </div>
          ))}
          {list.rows.length > 5 && <div className="muted" style={{ padding: "8px var(--s4)" }}>and {plural(list.rows.length - 5, "more row")}</div>}
        </div>
      )}

      <div className="grid-2">
        <div className="field"><label className="f">Name of this bulk call</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="October EMI reminders" /></div>
        <div className="field"><label className="f">Agent</label>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.length === 0 && <option value="">No agents yet — make one on Agents</option>}
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div className="field"><label className="f">Call from</label>
          <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
            {numbers.length === 0 && <option value="">No numbers yet — add one on Numbers</option>}
            {numbers.map((n) => <option key={n.id} value={n.id} disabled={n.status !== "active"}>{n.number} · {n.provider_label}{n.status !== "active" ? " (not ready)" : ""}</option>)}
          </select>
        </div>
        <div className="field"><label className="f">Calls at once</label>
          <select value={parallel} onChange={(e) => setParallel(e.target.value)}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
      <p className="hint">The agent's own settings apply to every call: its calling window, opening line, longest call and ring time. People already in Contacts keep their names; new numbers are added to Contacts.</p>
      <label className="check" style={{ marginTop: "var(--s3)" }}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>Everyone on this list has agreed to be called. India's TRAI/DND rules apply, and calls are recorded.</span></label>
      <div className="actions" style={{ justifyContent: "flex-end" }}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" onClick={start} disabled={busy || !list}><Icon name="call" />{busy ? "Starting…" : list ? `Start calling ${people(list.rows.length)}` : "Start calling"}</button>
      </div>
    </Modal>
  );
}

function RunDetail({ id }) {
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [run, setRun] = useState(null);
  const [filter, setFilter] = useState("all");
  const load = useCallback(() => get(`/api/bulk-calls/${id}`).then(setRun).catch((e) => toast(e.message, true)), [id, toast]);
  useEffect(() => { load(); }, [load]);
  const live = run && (run.status === "running" || run.counts.calling > 0);
  useEffect(() => { if (!live) return undefined; const t = setInterval(load, 3000); return () => clearInterval(t); }, [live, load]);

  const act = async (action) => {
    if (action === "cancel" && !(await confirm({ title: "Cancel this bulk call?", text: "No one else on the list is called. Calls already on the line carry on.", ok: "Cancel bulk call" }))) return;
    try { setRun({ ...(await post(`/api/bulk-calls/${id}/${action}`)), items: run.items }); load(); } catch (e) { toast(e.message, true); }
  };

  if (!run) return <Spinner />;
  const c = run.counts;
  const items = run.items.filter((i) => filter === "all" || (filter === "open" ? ["queued", "dialling", "calling"].includes(i.status) : i.status === filter));
  return (
    <section>
      <Link to="/bulk" className="back"><Icon name="back" />Bulk calls</Link>
      <header className="page">
        <div>
          <h1>{run.name}</h1>
          <div className="sub">{run.agent_name || "Agent deleted"} · {plural(run.parallel, "call")} at once · started {whenShort(run.created_at)}{run.created_by ? ` by ${run.created_by}` : ""}</div>
        </div>
        <div className="head-actions">
          {run.status === "running" && <button className="ghost" onClick={() => act("pause")}>Pause</button>}
          {run.status === "paused" && <button className="primary" onClick={() => act("resume")}>Resume</button>}
          {["running", "paused"].includes(run.status) && <button className="ghost danger-text" onClick={() => act("cancel")}>Cancel</button>}
        </div>
      </header>
      {run.waiting && <div className="banner"><Icon name="clock" /><span>{run.waiting}</span></div>}
      <div className="kpis bulk-kpis">
        {[["Progress", `${progress(c)}%`], ["On a call", c.calling], ["Picked up", c.answered], ["Waiting", c.queued], ["Skipped", c.skipped], ["Failed", c.failed]].map(([k, v]) => (
          <div key={k} className="kpi"><span className="k">{k}</span><span className="v">{v}</span></div>
        ))}
      </div>
      <div className="meter big"><i style={{ width: `${progress(c)}%` }} /></div>
      <div className="card list">
        <div className="list-bar">
          <span className={`pill ${run.status === "running" ? "live" : run.status === "paused" ? "warn" : "muted"}`}>{STATUS_LABEL[run.status]}</span>
          <span className="grow" />
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 180, height: 30 }} aria-label="Show">
            <option value="all">Everyone ({c.total})</option>
            <option value="open">Still to call ({c.queued + c.calling})</option>
            <option value="done">Done ({c.done})</option>
            <option value="skipped">Skipped ({c.skipped})</option>
            <option value="failed">Failed ({c.failed})</option>
          </select>
        </div>
        <div className="row head item-cols"><span>#</span><span>Name</span><span>Number</span><span>Status</span><span>Result</span></div>
        {items.length === 0 && <div className="empty">No one here.</div>}
        {items.slice(0, 500).map((i, n) => (
          <div key={i.id} className="row item-cols">
            <span className="muted num">{n + 1}</span>
            <b className="ellip">{i.name}</b>
            <span className="num ellip">{i.number}</span>
            <span><span className={`pill ${i.status === "calling" ? "live" : i.status === "failed" ? "failed" : i.status === "skipped" ? "muted" : i.status === "done" ? "answered" : "ringing"}`}>{ITEM_LABEL[i.status]}</span></span>
            <span className="ellip">{i.outcome ? <OutcomePill status={i.outcome} /> : <span className="muted" title={i.reason || ""}>{i.reason || (i.placed_at ? `since ${whenShort(i.placed_at)}` : "—")}</span>}</span>
          </div>
        ))}
        {items.length > 500 && <div className="muted" style={{ padding: "var(--s3) var(--s4)" }}>Showing the first 500. Use the filter to narrow it down.</div>}
      </div>
      {confirmNode}
    </section>
  );
}

