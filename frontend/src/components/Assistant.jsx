// Set things up by talking. A panel on the right where someone says, in their own words, what they
// want their agent to do. The assistant asks what it needs to know, says back in plain words what it
// understood, and only saves anything after they say yes. Nobody has to know what a URL is.
import { useEffect, useRef, useState } from "react";
import { get, post } from "../api.js";
import { Icon, useToast } from "../ui.jsx";

const GREETING = "Hi! Tell me what you would like your agent to do, in your own words. You can type, or press the microphone and just say it.";
const IDEAS = [
  "I want to know when the person will pay",
  "Ask for their order number and save it",
  "Check where their order is on my system",
];
const KIND_WORDS = { text: "words", number: "a number", date: "a date", yes_no: "yes or no", choice: "a choice", phone: "a phone number", amount: "an amount in rupees" };

// The browser's own speech recognition: free, and nothing is sent to us but the words.
const Recognition = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export default function Assistant({ agentId = null, onClose, onApplied }) {
  const toast = useToast();
  const [turns, setTurns] = useState([{ role: "assistant", content: GREETING, local: true }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [address, setAddress] = useState("");
  const [agents, setAgents] = useState([]);
  const [agent, setAgent] = useState(agentId ?? "");
  const [listening, setListening] = useState(false);
  const [lang, setLang] = useState("en-IN");
  const rec = useRef(null);
  const end = useRef(null);

  useEffect(() => { if (!agentId) get("/api/agents").then(setAgents).catch(() => {}); }, [agentId]);
  useEffect(() => { end.current?.scrollIntoView?.({ behavior: "smooth", block: "end" }); }, [turns, proposal, busy]);
  useEffect(() => () => rec.current?.stop?.(), []);

  const say = (role, content) => setTurns((t) => [...t, { role, content }]);

  const send = async (words) => {
    const said = (words ?? text).trim();
    if (!said || busy) return;
    setText("");
    setProposal(null);
    const next = [...turns, { role: "user", content: said }];
    setTurns(next);
    setBusy(true);
    try {
      const r = await post("/api/assistant/message", {
        messages: next.filter((t) => !t.local).map(({ role, content }) => ({ role, content })) });
      say("assistant", r.reply);
      setProposal(r.proposal);
    } catch (e) {
      say("assistant", e.message);
    } finally { setBusy(false); }
  };

  const listen = () => {
    if (!Recognition) return;
    if (listening) { rec.current?.stop(); return; }
    const r = new Recognition();
    r.lang = lang;
    r.interimResults = true;
    r.onresult = (event) => setText(Array.from(event.results).map((x) => x[0].transcript).join(" "));
    r.onerror = () => { setListening(false); toast("I could not hear that. Check the microphone is allowed, or type instead.", true); };
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };

  const confirm = async () => {
    if (!agent) return toast("Choose which agent this is for.", true);
    setBusy(true);
    try {
      const out = await post("/api/assistant/apply", { agent_id: agent, proposal: { ...proposal, ...(proposal.kind === "look_up" ? { url: address } : {}) } });
      say("assistant", out.message);
      setProposal(null); setAddress("");
      onApplied?.(out.agent);
    } catch (e) {
      say("assistant", e.message);
    } finally { setBusy(false); }
  };

  const change = () => { setProposal(null); say("assistant", "No problem. What would you like to change?"); };

  return (
    <aside className="assistant" aria-label="Set things up by chatting">
      <header className="assistant-head">
        <div><b>Set it up by chatting</b><div className="muted">Say it in your own words. Nothing is saved until you say yes.</div></div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </header>

      {!agentId && (
        <div className="assistant-agent"><label className="f" htmlFor="as-agent">Which agent is this for?</label>
          <select id="as-agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Choose an agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></div>
      )}

      <div className="assistant-chat">
        {turns.map((t, i) => <div key={i} className={`bubble ${t.role}`}>{t.content}</div>)}
        {turns.length === 1 && (
          <div className="ideas">{IDEAS.map((idea) => <button key={idea} type="button" className="chip" onClick={() => send(idea)}>{idea}</button>)}</div>
        )}
        {busy && <div className="bubble assistant typing" aria-live="polite">Thinking…</div>}

        {proposal && (
          <div className="proposal">
            <b>Is this what you meant?</b>
            {proposal.kind === "write_down" ? (
              <ul className="plain">{proposal.fields.map((f) => (
                <li key={f.key}>The agent asks for <b>{f.label.toLowerCase()}</b> ({KIND_WORDS[f.kind] ?? f.kind}) and writes it down.</li>))}</ul>
            ) : (
              <>
                <p className="hint">A tool called <b>{proposal.label}</b>. {proposal.description}
                  {proposal.inputs.length > 0 && <> The agent asks the caller for {proposal.inputs.map((i) => i.label.toLowerCase()).join(", ")}.</>}</p>
                <div className="field"><label className="f" htmlFor="as-address">The web address of your system</label>
                  <input id="as-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://yourcompany.com/orders" />
                  <span className="hint">Whoever looks after your system can give you this. Not sure? Say so, and I will have the agent write it down instead.</span></div>
              </>
            )}
            <div className="actions">
              <button type="button" className="primary" onClick={confirm} disabled={busy || (proposal.kind === "look_up" && !address.trim())}>Yes, set it up</button>
              <button type="button" className="ghost" onClick={change} disabled={busy}>Not quite</button>
            </div>
          </div>
        )}
        <div ref={end} />
      </div>

      <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea rows={2} value={text} placeholder={listening ? "Listening…" : "Type here, or press the microphone"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} maxLength={600} />
        <div className="assistant-buttons">
          {Recognition ? (
            <>
              <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language you will speak" disabled={listening}>
                <option value="en-IN">English</option><option value="hi-IN">Hindi</option>
              </select>
              <button type="button" className={`ghost mic${listening ? " on" : ""}`} onClick={listen} aria-pressed={listening}
                title={listening ? "Stop" : "Speak"}><Icon name="mic" />{listening ? "Stop" : "Speak"}</button>
            </>
          ) : <span className="hint">Speaking works in Chrome and Edge.</span>}
          <span className="grow" />
          <button type="submit" className="primary" disabled={busy || !text.trim()}>Send</button>
        </div>
      </form>
    </aside>
  );
}

/** The button that opens the assistant, shown only to people who can use it. */
export function AssistantButton({ onClick }) {
  return <button type="button" className="ghost assistant-open" onClick={onClick}><Icon name="chat" />Set it up by chatting</button>;
}
