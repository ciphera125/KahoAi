// Kaho Builder. Say what you want your agent to do, in your own words, and it is built: the question
// or tool is created, switched on for the agent, and the agent is told when to use it. What was built
// is shown with an Undo, so nothing needs confirming first and nothing is final until published.
import { useEffect, useRef, useState } from "react";
import { get, post } from "../api.js";
import { Icon, useToast } from "../ui.jsx";

const GREETING = "Tell me what you would like your agent to do, in your own words, and I will set it up.";
const IDEAS = [
  "Find out when the customer will pay",
  "Ask for the order number and save it",
  "Check where an order is on our system",
];
const KINDS = { write_down: "Question added", look_up: "Tool created" };

// The browser's own speech recognition: free, and nothing but the words leaves the page.
const Recognition = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export default function Assistant({ agentId = null, onClose, onApplied }) {
  const toast = useToast();
  const [turns, setTurns] = useState([{ role: "assistant", content: GREETING, local: true }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState([]);
  const [agent, setAgent] = useState(agentId ?? "");
  const [listening, setListening] = useState(false);
  const [lang, setLang] = useState("en-IN");
  const rec = useRef(null);
  const end = useRef(null);

  useEffect(() => { if (!agentId) get("/api/agents").then(setAgents).catch(() => {}); }, [agentId]);
  useEffect(() => { end.current?.scrollIntoView?.({ behavior: "smooth", block: "end" }); }, [turns, busy]);
  useEffect(() => () => rec.current?.stop?.(), []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = (turn) => setTurns((t) => [...t, turn]);

  const send = async (words) => {
    const said = (words ?? text).trim();
    if (!said || busy) return;
    rec.current?.stop?.();
    setText("");
    const next = [...turns, { role: "user", content: said }];
    setTurns(next);
    setBusy(true);
    try {
      const r = await post("/api/assistant/message", { agent_id: agent || undefined,
        messages: next.filter((t) => !t.local && !t.card).map(({ role, content }) => ({ role, content })) });
      add({ role: "assistant", content: r.reply, card: r.created ? { ...r.created, undo: r.undo } : null });
      if (r.created) onApplied?.();
    } catch (e) {
      add({ role: "assistant", content: e.message });
    } finally { setBusy(false); }
  };

  const undo = async (index) => {
    const card = turns[index].card;
    setBusy(true);
    try {
      await post("/api/assistant/undo", { agent_id: card.agent_id, undo: card.undo });
      setTurns((t) => t.map((x, i) => (i === index ? { ...x, card: { ...x.card, undone: true } } : x)));
      onApplied?.();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  const listen = () => {
    if (!Recognition) return;
    if (listening) { rec.current?.stop(); return; }
    const r = new Recognition();
    r.lang = lang;
    r.interimResults = true;
    r.onresult = (event) => setText(Array.from(event.results).map((x) => x[0].transcript).join(" "));
    r.onerror = () => { setListening(false); toast("I could not hear that. Allow the microphone, or type instead.", true); };
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };

  const typing = text.trim().length > 0;

  return (
    <aside className="kb" role="dialog" aria-label="Kaho Builder">
      <header className="kb-head">
        <span className="kb-mark" aria-hidden="true"><Icon name="spark" /></span>
        <div className="kb-title"><b>Kaho Builder</b><span>Describe it. It gets built.</span></div>
        <button type="button" className="kb-close" onClick={onClose} aria-label="Close" title="Close"><Icon name="x" /></button>
      </header>

      {!agentId && (
        <div className="kb-agent">
          <label htmlFor="kb-agent">Building for</label>
          <select id="kb-agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Choose an agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      )}

      <div className="kb-chat">
        {turns.map((t, i) => (
          <div key={i} className={`kb-row ${t.role}`}>
            <div className="kb-bubble">{t.content}</div>
            {t.card && (
              <div className={`kb-card${t.card.undone ? " undone" : ""}`}>
                <span className="kb-tick"><Icon name={t.card.undone ? "x" : "check"} /></span>
                <div className="kb-card-body">
                  <b>{t.card.undone ? "Undone" : KINDS[t.card.kind]}</b>
                  <span>{t.card.names.join(", ")}</span>
                  {!t.card.undone && <small>Saved as a draft. Publish the agent to make it live.</small>}
                </div>
                {!t.card.undone && <button type="button" className="kb-undo" disabled={busy} onClick={() => undo(i)}>Undo</button>}
              </div>
            )}
          </div>
        ))}
        {turns.length === 1 && (
          <div className="kb-ideas">{IDEAS.map((idea) => <button key={idea} type="button" onClick={() => send(idea)}>{idea}</button>)}</div>
        )}
        {busy && <div className="kb-row assistant"><div className="kb-bubble kb-dots" aria-label="Working"><i /><i /><i /></div></div>}
        <div ref={end} />
      </div>

      <form className="kb-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <div className="kb-field">
          <textarea rows={1} value={text} maxLength={600} aria-label="Message"
            placeholder={listening ? "Listening…" : "Message Kaho Builder"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          {Recognition && !typing && (
            <button type="button" className={`kb-lang`} onClick={() => setLang(lang === "en-IN" ? "hi-IN" : "en-IN")}
              disabled={listening} title="Language you will speak" aria-label="Language you will speak">{lang === "en-IN" ? "EN" : "हि"}</button>
          )}
        </div>
        {typing || !Recognition ? (
          <button type="submit" className="kb-round send" disabled={busy || !typing} aria-label="Send"><Icon name="send" /></button>
        ) : (
          <button type="button" className={`kb-round mic${listening ? " on" : ""}`} onClick={listen}
            aria-pressed={listening} aria-label={listening ? "Stop" : "Speak"}><Icon name="mic" /></button>
        )}
      </form>
    </aside>
  );
}

/** The button that opens Kaho Builder, shown only to people who can use it. */
export function AssistantButton({ onClick }) {
  return <button type="button" className="kb-open" onClick={onClick}><Icon name="spark" />Kaho Builder</button>;
}
