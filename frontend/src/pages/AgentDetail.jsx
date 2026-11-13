import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { del, get, patch, post } from "../api.js";
import { can, isAdmin, useMe } from "../auth.jsx";
import AgentCalls from "../components/AgentCalls.jsx";
import Assistant, { AssistantButton } from "../components/Assistant.jsx";
import { Icon, Menu, Spinner, useConfirm, usePaged, useToast } from "../ui.jsx";

const TOOL_LABELS = {
  end_call: "End the call", capture_lead: "Save details", transfer_to_human: "Transfer to a person", call_webhook: "Your system (webhook)",
};

export default function AgentDetail() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [agent, setAgent] = useState(null);
  const [prompts, setPrompts] = useState([]);
  const [tools, setTools] = useState([]);
  const [limits, setLimits] = useState({ max_minutes: 30, ring_secs: [15, 60] });
  const [check, setCheck] = useState({ problems: [], can_publish: true });
  const [languages, setLanguages] = useState([]);
  const [shown, setShown] = useState(null); // what Kaho Builder just made: { keys } to scroll to and highlight for a few seconds
  const TABS = ["prompt", "tools", "questions", "knowledge", "settings", "calls", "versions"];
  const [params] = useSearchParams();
  const [tab, setTab] = useState(TABS.includes(params.get("tab")) ? params.get("tab") : "prompt");
  // A link to ?tab=tools (from the Builder, say) opens that tab even when the agent is already on screen.
  useEffect(() => {
    const t = params.get("tab");
    if (!TABS.includes(t)) return;
    setTab(t);
    if (t === "tools") setShown({ keys: (params.get("show") ?? "").split(",").filter(Boolean).slice(0, 20) });
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const [chatting, setChatting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, p, t, cfg, c] = await Promise.all([get(`/api/agents/${agentId}`), get("/api/prompts"), get("/api/tools"),
        get("/api/config"), get(`/api/agents/${agentId}/check`)]);
      setAgent(a); setPrompts(p.filter((x) => x.agent_id === a.id)); setTools(t); setLimits(cfg.limits); setLanguages(cfg.languages ?? []); setCheck(c);
    } catch (e) { toast(e.message, true); navigate("/agents"); }
  }, [agentId, navigate, toast]);
  useEffect(() => { load(); }, [load]);
  if (!agent) return <Spinner />;

  const removeAgent = async () => {
    if (!(await confirm({ title: `Delete ${agent.name}?`, text: "Its prompts are kept on the Prompts page. Numbers it answered go back to the default persona.", ok: "Delete agent" }))) return;
    await del(`/api/agents/${agent.id}`); toast("Agent deleted."); navigate("/agents");
  };

  return (
    <section>
      <button type="button" className="link" style={{ display: "inline-flex", gap: 4, marginBottom: 8 }} onClick={() => navigate("/agents")}><Icon name="back" />All agents</button>
      <header className="page" style={{ marginTop: 8 }}>
        <div style={{ minWidth: 0 }}><h1>{agent.name}</h1><div className="sub">{agent.description || "No description yet."}</div></div>
        <div className="head-actions">
          {isAdmin(me) && <Menu items={[["Delete agent", removeAgent, true]]} />}
        </div>
      </header>
      {!can(me, "agents.edit") && <div className="card explain"><b>You can look at this agent but not change it.</b>
        <p className="hint">Ask an admin for a role that can build agents (Manager or Agent builder).</p></div>}
      {can(me, "agents.edit") && <PublishBar agent={agent} check={check} me={me} confirm={confirm} onChanged={load} />}
      <div className="seg">
        {TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t === "prompt" ? "Prompt" : t === "tools" ? "Tools" : t === "questions" ? "Questions to save" : t === "knowledge" ? "Knowledge" : t === "settings" ? "Call settings" : t === "calls" ? "Call history" : "Versions"}</button>)}
      </div>
      {tab === "prompt" && <PromptTab agent={agent} prompts={prompts} onChanged={load} />}
      {(tab === "tools" || tab === "questions") && (can(me, "agents.edit") || can(me, "tools.custom")) && (
        <div className="assist-bar"><span className="hint">Tell Kaho Builder what you need and it sets it up.</span><AssistantButton onClick={() => setChatting(true)} /></div>)}
      {tab === "tools" && <ToolsTab agent={agent} tools={tools} onChanged={load} shown={shown} onShown={() => setShown(null)} />}
      {tab === "settings" && <SettingsTab agent={agent} limits={limits} languages={languages} onChanged={load} />}
      {tab === "calls" && <AgentCalls agent={agent} />}
      {tab === "questions" && <QuestionsTab agent={agent} onChanged={load} />}
      {tab === "knowledge" && <KnowledgeTab agent={agent} onChanged={load} />}
      {tab === "versions" && <VersionsTab agent={agent} confirm={confirm} onChanged={load} />}
      {chatting && <Assistant agentId={agent.id} onClose={() => setChatting(false)} onApplied={() => load()} onShow={(card) => { setTab("tools"); setShown({ keys: card?.keys ?? [] }); setChatting(false); }} />}
      {confirmNode}
    </section>
  );
}

const TEST_WORDS = {
  none: "Not tested yet.", stale: "Changed since it was last tested.",
  passed: "Passed.", failed: "Did not pass.",
};

/** A short simulated conversation with the draft, so a problem shows up here rather than
 * on a caller. Tools are shown but never really run. */
function TestPanel({ agent, check, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [lines, setLines] = useState("");
  if (!check.test_required && !result) return null;

  const run = async () => {
    setBusy(true);
    try {
      const said = lines.split("\n").map((l) => l.trim()).filter(Boolean);
      setResult(await post(`/api/agents/${agent.id}/test`, said.length ? { messages: said } : {}));
      onChanged();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  const standing = check.test?.status ?? "none";
  return (
    <div className="answers" style={{ marginTop: "var(--s3)" }}>
      <div className="publish-state">
        <div>
          <b>Test this agent</b>
          <div className="hint">{TEST_WORDS[standing]} {standing === "failed" || standing === "stale" ? check.test.message : ""}</div>
        </div>
        <button className="ghost" onClick={run} disabled={busy}>{busy ? "Testing…" : standing === "none" ? "Test this agent" : "Test again"}</button>
      </div>
      <details style={{ marginTop: 6 }}>
        <summary className="hint">Choose what to say to it</summary>
        <textarea rows={3} value={lines} placeholder={"One line per turn. Leave empty to use a few ordinary ones."}
          onChange={(e) => setLines(e.target.value)} />
      </details>
      {result && (
        <div style={{ marginTop: "var(--s3)" }}>
          <div className="card-title" style={{ marginBottom: 6 }}>{result.passed ? "It held a conversation" : "It did not pass"}</div>
          {!result.passed && <div className="hint" style={{ color: "var(--warn)" }}>{result.note}</div>}
          {result.turns.map((t, i) => (
            <div key={i} className="tree-turn">
              <div className="hint tree-said">They say: “{t.said}”</div>
              {(t.tools ?? []).map((c, j) => (
                <div key={j} className={`tree-tool ${c.status}`}>
                  <b>{c.label}</b> <span className="hint">{c.status === "refused" ? "not one of its tools" : "would have run (nothing was changed)"}</span>
                  {c.sent && <div className="hint"><code>{JSON.stringify(c.sent)}</code></div>}
                  {c.why && <div className="hint">{c.why}</div>}
                </div>
              ))}
              <div className="msg agent" style={{ maxWidth: "100%" }}>{t.reply || <i>said nothing</i>}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** What is live, what is only saved, and the one button that changes that. */
function PublishBar({ agent, check, me, confirm, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const live = agent.live_version;
  const untested = check.test_required && check.test?.status !== "passed";
  const blocked = check.problems.length > 0 || untested;

  const publish = async (override = false) => {
    setBusy(true);
    try {
      await post(`/api/agents/${agent.id}/publish`, override ? { override: true } : {});
      toast(override ? "Published over the checks. It is live now." : "Published. New calls use it from now on.");
      onChanged();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  const publishAnyway = async () => {
    const ok = await confirm({ title: "Publish anyway?",
      text: "We think this draft has a problem, or has not passed a test. If you know it is fine, you can publish it. "
        + "What you overrode is kept on this version, with your name.",
      ok: "I know this is not a tool, publish anyway" });
    if (ok) await publish(true);
  };

  return (
    <div className={`card publish-bar${agent.draft_changed ? " draft" : ""}`}>
      <div className="publish-state">
        <div>
          <b>{agent.draft_changed ? "You have unpublished changes" : "Everything is published"}</b>
          <div className="hint">
            {live ? `Version ${live.number} is live${live.published_by_name ? `, published by ${live.published_by_name}` : ""} on ${new Date(live.published_at).toLocaleDateString()}.`
              : "Nothing is live yet."}
            {agent.draft_changed ? " Calls keep using the live version until you publish." : ""}
          </div>
        </div>
        {agent.draft_changed && (blocked
          ? <button className="ghost" disabled={busy || !isAdmin(me)} onClick={publishAnyway}>Publish anyway</button>
          : <button className="primary" disabled={busy} onClick={() => publish(false)}>Publish</button>)}
      </div>
      {blocked && agent.draft_changed && (
        <ul className="problems">
          {check.problems.map((p) => <li key={p.code + p.found}>{p.message}</li>)}
          {untested && check.problems.length === 0 && <li>Test this agent first. Publishing needs a test of exactly these words to have passed.</li>}
          {!isAdmin(me) && <li className="hint">Only an owner or admin can publish over this.</li>}
        </ul>
      )}
      {agent.draft_changed && <TestPanel agent={agent} check={check} onChanged={onChanged} />}
    </div>
  );
}

const KINDS = [
  ["text", "Anything they say"], ["date", "A date"], ["amount", "An amount in rupees"],
  ["number", "A number"], ["yes_no", "Yes or no"], ["phone", "A phone number"], ["choice", "One of a list"],
];

/** The questions this agent asks and writes down. Deliberately a plain list: a label, what
 * kind of answer it is, and optionally the words to ask it in. */
function QuestionsTab({ agent, onChanged }) {
  const toast = useToast();
  const [fields, setFields] = useState(agent.settings.capture_fields ?? []);
  const [confirmAnswers, setConfirmAnswers] = useState(agent.settings.confirm_answers !== false);

  const set = (i, patch) => setFields((list) => list.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = () => setFields((list) => [...list, { label: "", kind: "text", required: false, ask: "", choices: [] }]);
  const remove = (i) => setFields((list) => list.filter((_, j) => j !== i));
  const save = async () => {
    try {
      await patch(`/api/agents/${agent.id}`, { settings: { capture_fields: fields, confirm_answers: confirmAnswers } });
      toast("Saved as a draft. Publish it when you are ready."); onChanged();
    } catch (e) { toast(e.message, true); }
  };

  return (
    <div className="card" style={{ maxWidth: 860 }}>
      <div className="card-head"><span className="card-title">What the agent should write down</span></div>
      <p className="hint" style={{ marginBottom: "var(--s4)" }}>
        Each question here becomes something the agent can save when the caller answers it, like a payment date.
        You still have to tell the agent to ask it, in the prompt. Switch on <b>Save what the caller says</b> on
        the Tools tab for any of this to happen.
      </p>
      {fields.length === 0 && <p className="hint">No questions yet.</p>}
      {fields.map((f, i) => (
        <div key={i} className="q-row">
          <div className="field"><label className="f">Question</label>
            <input value={f.label} maxLength={60} placeholder="Payment date" onChange={(e) => set(i, { label: e.target.value })} /></div>
          <div className="field"><label className="f">Kind of answer</label>
            <select value={f.kind} onChange={(e) => set(i, { kind: e.target.value })}>
              {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          <label className="switch-inline"><input type="checkbox" checked={!!f.required} onChange={(e) => set(i, { required: e.target.checked })} /> Must have</label>
          <button className="ghost" onClick={() => remove(i)} aria-label="Remove this question"><Icon name="trash" /></button>
          <div className="field" style={{ gridColumn: "1 / -1" }}><label className="f">How to ask it (optional)</label>
            <input value={f.ask || ""} maxLength={200} placeholder="On what exact date will you pay?" onChange={(e) => set(i, { ask: e.target.value })} /></div>
          {f.kind === "choice" && (
            <div className="field" style={{ gridColumn: "1 / -1" }}><label className="f">The options, separated by commas</label>
              <input value={(f.choices || []).join(", ")} placeholder="UPI, Bank transfer, Cash"
                onChange={(e) => set(i, { choices: e.target.value.split(",").map((c) => c.trim()).filter(Boolean) })} /></div>
          )}
        </div>
      ))}
      <button className="ghost" onClick={add}><Icon name="plus" />Add a question</button>
      <div className="toggle-line" style={{ marginTop: "var(--s4)" }}>
        <div><b>Read it back before saving</b><div className="hint">For dates, amounts and phone numbers, the agent repeats what it heard and waits for a yes. Strongly recommended.</div></div>
        <label className="switch"><input type="checkbox" checked={confirmAnswers} onChange={(e) => setConfirmAnswers(e.target.checked)} /><span /></label>
      </div>
      <div className="actions"><button className="primary" onClick={save}>Save questions</button></div>
    </div>
  );
}

function VersionsTab({ agent, confirm, onChanged }) {
  const toast = useToast();
  const [versions, setVersions] = useState(null);
  const load = useCallback(() => get(`/api/agents/${agent.id}/versions`).then(setVersions).catch((e) => toast(e.message, true)), [agent.id, toast]);
  useEffect(() => { load(); }, [load]);
  const [shownVersions, versionPager] = usePaged(versions ?? []);
  if (!versions) return <Spinner />;

  const restore = async (v) => {
    if (!(await confirm({ title: `Go back to version ${v.number}?`,
      text: "Its prompt, tools and settings become the live ones again, as a new version. Nothing in this list is lost.",
      ok: `Make version ${v.number} live` }))) return;
    try { await post(`/api/agents/${agent.id}/versions/${v.id}/restore`, {}); toast("Done. New calls use it from now on."); onChanged(); load(); }
    catch (e) { toast(e.message, true); }
  };

  return (
    <div className="card" style={{ maxWidth: 820 }}>
      <div className="card-head"><span className="card-title">Every version that has been live</span></div>
      <table className="rows">
        <tbody>
          {shownVersions.map((v) => (
            <tr key={v.id}>
              <td style={{ width: 90 }}><b>Version {v.number}</b></td>
              <td>
                <div>{v.note || "Published"}{v.live ? <span className="pill live" style={{ marginLeft: 8 }}>Live</span> : null}</div>
                <div className="hint">{new Date(v.published_at).toLocaleString()}{v.published_by_name ? ` · ${v.published_by_name}` : ""}</div>
                {v.overrides?.length > 0 && <div className="hint" style={{ color: "var(--warn)" }}>Published over {v.overrides.length} warning{v.overrides.length > 1 ? "s" : ""}.</div>}
              </td>
              <td style={{ textAlign: "right" }}>{!v.live && <button className="ghost" onClick={() => restore(v)}>Make live again</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {versionPager}
    </div>
  );
}

/** Typing {{ offers what this agent can actually fill in: who it is calling, what it has
 * saved about them, and the call's own facts. Picking one puts it in at the cursor, so
 * nobody has to remember the spelling, which is how the 2026-11-07 prompt went wrong. */
function VariablePicker({ groups, onPick, onClose }) {
  const [find, setFind] = useState("");
  const matches = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => `${i.name} ${i.label}`.toLowerCase().includes(find.toLowerCase())) }))
    .filter((g) => g.items.length);
  return (
    <div className="picker">
      <input autoFocus value={find} placeholder="Find a detail…" aria-label="Find a detail"
        onChange={(e) => setFind(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }} />
      <div className="picker-list">
        {matches.length === 0 && <div className="hint" style={{ padding: 8 }}>Nothing matches.</div>}
        {matches.map((g) => (
          <div key={g.group}>
            <div className="picker-group">{g.group}</div>
            {g.items.map((i) => (
              <button key={i.name} className="picker-item" onClick={() => onPick(i.name)}>
                <b>{i.label}</b><code>{`{{${i.name}}}`}</code>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="hint" style={{ padding: "6px 8px" }}>These are filled in before the call, so the agent never asks for them.</div>
    </div>
  );
}

function PromptTab({ agent, prompts, onChanged }) {
  const toast = useToast();
  const active = prompts.find((p) => p.id === agent.active_prompt_id) || prompts[0];
  const [sel, setSel] = useState(active?.id);
  const current = prompts.find((p) => p.id === sel) || active;
  const [name, setName] = useState(current?.name || "");
  const [text, setText] = useState(current?.prompt || "");
  const [groups, setGroups] = useState([]);
  const [picking, setPicking] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => { setName(current?.name || ""); setText(current?.prompt || ""); }, [sel]);
  useEffect(() => { get(`/api/agents/${agent.id}/variables`).then(setGroups).catch(() => setGroups([])); }, [agent.id]);

  // "{{" anywhere opens the picker; what it inserts replaces those two characters.
  const onType = (e) => {
    setText(e.target.value);
    const upto = e.target.value.slice(0, e.target.selectionStart);
    if (upto.endsWith("{{")) setPicking(true);
  };
  const insert = (variableName) => {
    const box = boxRef.current;
    const at = box ? box.selectionStart : text.length;
    const before = text.slice(0, at).replace(/\{\{$/, "");
    const next = `${before}{{${variableName}}}${text.slice(at)}`;
    setText(next);
    setPicking(false);
    requestAnimationFrame(() => {
      if (!box) return;
      const caret = before.length + variableName.length + 4;
      box.focus();
      box.setSelectionRange(caret, caret);
    });
  };
  if (!current) return <div className="card">This agent has no prompt.</div>;

  const save = async () => {
    try { await patch(`/api/prompts/${current.id}`, { name, text }); toast("Saved as a draft. Publish it when you are ready."); onChanged(); } catch (e) { toast(e.message, true); }
  };
  const use = async () => { try { await patch(`/api/agents/${agent.id}`, { active_prompt_id: current.id }); toast("Saved as a draft. Publish it when you are ready."); onChanged(); } catch (e) { toast(e.message, true); } };
  const addPrompt = async () => {
    const r = prompt("Name the new prompt:"); if (!r) return;
    try { const p = await post("/api/prompts", { name: r, prompt: "You are…", agent_id: agent.id }); toast("Prompt created."); setSel(p.id); onChanged(); } catch (e) { toast(e.message, true); }
  };
  return (
    <div className="grid-side">
      <div className="card">
        <div className="chips">
          {prompts.map((p) => <button key={p.id} className={`chip${p.id === sel ? " on" : ""}`} onClick={() => setSel(p.id)}>{p.name}{p.id === agent.active_prompt_id ? " · in use" : ""}</button>)}
          <button className="chip" onClick={addPrompt}><Icon name="plus" />New prompt</button>
        </div>
        <div className="field"><label className="f">Prompt name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field" style={{ position: "relative" }}><label className="f">Prompt</label>
          <textarea ref={boxRef} value={text} onChange={onType} />
          <span className="hint">Type <code>{"{{"}</code> to drop in something you already know, like their name.</span>
          {picking && <VariablePicker groups={groups} onPick={insert} onClose={() => setPicking(false)} />}
        </div>
        <div className="actions"><button className="primary" onClick={save}>Save prompt</button>{current.id !== agent.active_prompt_id && <button className="ghost" onClick={use}>Use on calls</button>}</div>
      </div>
      <div className="card"><div className="card-head"><span className="card-title">How it works</span></div>
        <p className="hint">Calls use the prompt marked <b>in use</b>. Saving keeps your work as a draft; calls carry on with the published version until you press <b>Publish</b> at the top. Every save is kept, and you can go back to any published version on the Versions tab.</p>
      </div>
    </div>
  );
}

const FLASH_MS = 5000;
const KIND_WORDS = { text: "words", number: "a number", date: "a date", yes_no: "yes or no", choice: "a choice", phone: "a phone number", amount: "an amount" };

function ToolsTab({ agent, tools, onChanged, shown = null, onShown }) {
  const toast = useToast();
  const card = useRef(null);
  const [picked, setPicked] = useState(agent.tools);
  const [flash, setFlash] = useState(new Set());
  // When the agent changes underneath (Kaho Builder adds a tool, a version is restored) the switches follow,
  // so a later "Save tools" can never undo what was just set up.
  const live = agent.tools.join("|");
  useEffect(() => { setPicked(agent.tools); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (name) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));
  const save = async () => { try { await patch(`/api/agents/${agent.id}`, { tools: picked }); toast("Saved as a draft. Publish it when you are ready."); onChanged(); } catch (e) { toast(e.message, true); } };
  const questions = agent.settings.capture_fields ?? [];

  // Sent here by Kaho Builder: bring what it made into view and light it up for five seconds.
  useEffect(() => {
    if (!shown) return undefined;
    const keys = new Set(shown.keys);
    // A question it added also lights the "Save what the caller says" tool that holds it.
    if (questions.some((q) => keys.has(q.key))) keys.add("save_answer");
    setFlash(keys);
    const scroll = setTimeout(() => {
      const first = card.current?.querySelector("[data-flash='true']");
      (first ?? card.current)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    }, 150);
    const off = setTimeout(() => { setFlash(new Set()); onShown?.(); }, FLASH_MS);
    return () => { clearTimeout(scroll); clearTimeout(off); };
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const lit = (key) => flash.has(key);
  const row = (t) => (
    <div key={t.name} className={`toggle-line${lit(t.name) ? " flash" : ""}`} data-flash={lit(t.name)}>
      <div>
        <b>{t.label || TOOL_LABELS[t.name]}</b>
        {t.made_by === "builder" && <span className="made-by" title="Set up for you by Kaho Builder"><Icon name="spark" />Kaho Builder</span>}
        <div className="hint">{t.description}</div>
        {t.name === "save_answer" && picked.includes("save_answer") && (
          questions.length === 0
            ? <div className="hint">No questions yet. Add them on the Questions to save tab, or tell Kaho Builder.</div>
            : (
              <ul className="saved-questions" aria-label="Questions this tool asks and saves">
                {questions.map((q) => (
                  <li key={q.key} className={lit(q.key) ? "flash" : ""} data-flash={lit(q.key)}>
                    <span className="sq-title">Save: {q.label}</span>
                    {q.made_by === "builder" && <span className="made-by" title="Set up for you by Kaho Builder"><Icon name="spark" />Kaho Builder</span>}
                    <span className="hint">{KIND_WORDS[q.kind] ?? q.kind}{q.ask ? ` · asked like: “${q.ask}”` : ""}</span>
                  </li>
                ))}
              </ul>
            )
        )}
        {!t.ready && <div className="hint" style={{ color: "var(--warn)" }}>Needs {t.needs} to be set on the server first.</div>}
      </div>
      <label className="switch"><input type="checkbox" checked={picked.includes(t.name)} onChange={() => toggle(t.name)} /><span /></label>
    </div>
  );
  const own = tools.filter((t) => t.custom);
  return (
    <div className="card" style={{ maxWidth: 760 }} ref={card}>
      <div className="card-head"><span className="card-title">What this agent can do on a call</span></div>
      {tools.filter((t) => !t.custom).map(row)}
      {own.length > 0 && (
        <>
          <div className="tools-divider">Your own tools</div>
          {own.map(row)}
        </>
      )}
      <div className="actions"><button className="primary" onClick={save}>Save tools</button></div>
    </div>
  );
}

function SettingsTab({ agent, limits, languages, onChanged }) {
  const toast = useToast();
  const s = agent.settings;
  const [opening, setOpening] = useState(s.opening_line || "");
  const [maxMin, setMaxMin] = useState(s.max_minutes);
  const [ring, setRing] = useState(s.ring_secs);
  const [lang, setLang] = useState(languages.some((l) => l.value === s.language) ? s.language : "auto");
  const [voicemail, setVoicemail] = useState(s.voicemail || "talk");
  const w = s.call_window || { enabled: false, start: "09:00", end: "21:00", timezone: "Asia/Kolkata" };
  const [cw, setCw] = useState(w);
  const save = async () => {
    try {
      await patch(`/api/agents/${agent.id}`, { settings: { opening_line: opening, max_minutes: maxMin, ring_secs: ring, call_window: cw, language: lang, voicemail } });
      toast("Saved as a draft. Publish it when you are ready."); onChanged();
    } catch (e) { toast(e.message, true); }
  };
  return (
    <div className="grid-side">
      <div className="card">
        <div className="field"><label className="f">Language</label>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            {languages.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          <span className="hint">{languages.find((l) => l.value === lang)?.hint}
            {" "}You can still choose a different one for a single call on the Calls page.</span>
        </div>
        <div className="field"><label className="f">If an answering machine picks up</label>
          <select value={voicemail} onChange={(e) => setVoicemail(e.target.value)}>
            <option value="talk">Carry on and speak</option>
            <option value="hang_up">Hang up</option>
          </select>
          <span className="hint">For calls we place. Plivo listens to the first few seconds; hanging up avoids talking to a recording. Try it on a real call before relying on it.</span>
        </div>
        <div className="field"><label className="f">Opening line</label><input value={opening} onChange={(e) => setOpening(e.target.value)} maxLength={200} placeholder="Leave empty to let the agent introduce itself" /></div>
        <div className="field"><label className="f">Longest call (minutes)</label><input type="number" value={maxMin} min={1} max={limits.max_minutes} onChange={(e) => setMaxMin(e.target.value)} /><span className="hint">Up to {limits.max_minutes} minutes on this server.</span></div>
        <div className="field"><label className="f">Ring for (seconds)</label><input type="number" value={ring} min={limits.ring_secs[0]} max={limits.ring_secs[1]} onChange={(e) => setRing(e.target.value)} /></div>
        <div className="actions"><button className="primary" onClick={save}>Save settings</button></div>
      </div>
      <div className="card">
        <div className="card-head"><span className="card-title">Calling window</span><label className="switch"><input type="checkbox" checked={cw.enabled} onChange={(e) => setCw({ ...cw, enabled: e.target.checked })} /><span /></label></div>
        <p className="hint" style={{ marginBottom: "var(--s4)" }}>When on, this agent places calls only between these hours. A call outside the window is refused with a message, so no one is dialled at the wrong time. TRAI allows commercial calls 09:00–21:00.</p>
        <div className="grid-2">
          <div className="field"><label className="f">From</label><input type="time" value={cw.start} disabled={!cw.enabled} onChange={(e) => setCw({ ...cw, start: e.target.value })} /></div>
          <div className="field"><label className="f">To</label><input type="time" value={cw.end} disabled={!cw.enabled} onChange={(e) => setCw({ ...cw, end: e.target.value })} /></div>
        </div>
        <div className="field"><label className="f">Time zone</label><input value={cw.timezone} disabled={!cw.enabled} onChange={(e) => setCw({ ...cw, timezone: e.target.value })} placeholder="Asia/Kolkata" /></div>
        <div className="actions"><button className="primary" onClick={save}>Save calling window</button></div>
      </div>
    </div>
  );
}

/** Documents the agent can answer from. Text only: paste it, or load a .txt, .md or .csv file. */
function KnowledgeTab({ agent, onChanged }) {
  const toast = useToast();
  const me = useMe();
  const [confirm, confirmNode] = useConfirm();
  const [docs, setDocs] = useState(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = can(me, "agents.edit");
  const on = agent.tools.includes("search_knowledge");

  const load = useCallback(() => get(`/api/agents/${agent.id}/knowledge`).then(setDocs).catch((e) => toast(e.message, true)), [agent.id, toast]);
  useEffect(() => { load(); }, [load]);

  const readFile = async (file) => {
    if (!file) return;
    if (file.size > 200000) return toast("That file is too big. Split it into parts of up to 20,000 letters each.", true);
    setText(await file.text());
    setTitle((t) => t || file.name.replace(/\.[^.]+$/, ""));
  };
  const addDoc = async () => {
    setBusy(true);
    try {
      await post(`/api/agents/${agent.id}/knowledge`, { title, text });
      if (!on) await patch(`/api/agents/${agent.id}`, { tools: [...agent.tools, "search_knowledge"] });
      setTitle(""); setText(""); toast("Added. Publish the agent to make it live."); load(); onChanged();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  const remove = async (d) => {
    if (!(await confirm({ title: `Remove “${d.title}”?`, text: "The agent will stop answering from it once you publish.", ok: "Remove" }))) return;
    try { await del(`/api/agents/${agent.id}/knowledge/${d.id}`); load(); } catch (e) { toast(e.message, true); }
  };

  return (
    <div className="stack">
      <div className="card explain">
        <b>Teach the agent about your business</b>
        <p className="hint">Add a price list, an FAQ or your policies. When a caller asks something, the agent looks it up here and answers only from what you wrote,
          and says it is not sure if the answer is not there. Adding a document switches the lookup on for this agent.</p>
      </div>
      {docs === null ? <Spinner /> : docs.length > 0 && (
        <div className="card">
          <table className="rows"><tbody>
            {docs.map((d) => (
              <tr key={d.id}><td><b>{d.title}</b><div className="hint">{d.chars.toLocaleString("en-IN")} letters</div></td>
                <td style={{ textAlign: "right" }}>{editable && <button className="ghost" onClick={() => remove(d)} aria-label={`Remove ${d.title}`}><Icon name="trash" /></button>}</td></tr>
            ))}
          </tbody></table>
        </div>
      )}
      {editable && (
        <div className="card">
          <div className="field"><label className="f" htmlFor="kb-title">Name of the document</label>
            <input id="kb-title" value={title} maxLength={120} placeholder="Loan FAQ" onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="field"><label className="f" htmlFor="kb-text">What it says</label>
            <textarea id="kb-text" rows={8} value={text} maxLength={20000} placeholder="Paste the text here, or load a file below."
              onChange={(e) => setText(e.target.value)} />
            <span className="hint">{text.length.toLocaleString("en-IN")} of 20,000 letters. Put a blank line between topics: the agent finds the right paragraph.</span></div>
          <div className="actions">
            <label className="ghost file-pick">Load a text file<input type="file" accept=".txt,.md,.csv,text/plain" hidden onChange={(e) => readFile(e.target.files?.[0])} /></label>
            <button className="primary" onClick={addDoc} disabled={busy || !title.trim() || !text.trim()}>Add document</button>
          </div>
        </div>
      )}
      {confirmNode}
    </div>
  );
}
