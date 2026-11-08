// Ring one person from the Contacts list. The same call as the Calls page makes, with the same checks on
// the server (consent stated, Do not call, calling hours); this window only collects the choices.
import { useEffect, useState } from "react";
import { ApiError, get, post } from "../api.js";
import { Icon, Modal, Spinner, useToast } from "../ui.jsx";

export default function CallContact({ contact, onClose, onPlaced }) {
  const toast = useToast();
  const [agents, setAgents] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [agentId, setAgentId] = useState("");
  const [fromId, setFromId] = useState("");
  const [to, setTo] = useState(contact.numbers[0]?.number ?? "");
  const [consent, setConsent] = useState(contact.consent === "given");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    Promise.all([get("/api/agents"), get("/api/numbers")]).then(([a, n]) => {
      setAgents(a); setNumbers(n);
      const ready = n.filter((x) => x.status === "active");
      setFromId((n.find((x) => x.is_default && x.status === "active") ?? ready[0])?.id ?? "");
    }).catch((e) => toast(e.message, true));
  }, [toast]);

  const ready = numbers.filter((n) => n.status === "active");
  const go = async () => {
    setProblem(null);
    if (!consent) return setProblem("Confirm that this person has agreed to be called.");
    setBusy(true);
    try {
      const r = await post("/api/calls", { from_id: fromId, to, consent: true, agent_id: agentId || undefined });
      toast(`Ringing ${contact.name}.`);
      onPlaced?.(r);
      onClose();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The call could not be placed.");
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Call ${contact.name}`} onClose={onClose}>
      {!agents ? <Spinner /> : (
        <>
          {ready.length === 0 && <p className="hint" style={{ color: "var(--warn)" }}>There is no number to call from yet. Add one on the Numbers page.</p>}
          <div className="field"><label className="f" htmlFor="cc-agent">Which agent should talk?</label>
            <select id="cc-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Default persona (no agent)</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></div>
          {contact.numbers.length > 1 && (
            <div className="field"><label className="f" htmlFor="cc-to">Which number?</label>
              <select id="cc-to" value={to} onChange={(e) => setTo(e.target.value)}>
                {contact.numbers.map((n) => <option key={n.id} value={n.number}>{n.number}</option>)}
              </select></div>
          )}
          {contact.numbers.length === 1 && <div className="field"><label className="f">Number</label><div className="num">{to}</div></div>}
          <div className="field"><label className="f" htmlFor="cc-from">Call from</label>
            <select id="cc-from" value={fromId} onChange={(e) => setFromId(e.target.value)}>
              {numbers.map((n) => <option key={n.id} value={n.id} disabled={n.status !== "active"}>{n.number} · {n.provider_label}{n.status !== "active" ? " (not ready)" : ""}</option>)}
            </select></div>
          <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{contact.name} has agreed to be called. India's TRAI/DND rules apply, and that is your responsibility.</span></label>
          {problem && <p className="hint" role="alert" style={{ color: "var(--bad)" }}>{problem}</p>}
          <div className="actions" style={{ justifyContent: "flex-end" }}>
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="primary" onClick={go} disabled={busy || !fromId || !to}><Icon name="call" />Call now</button>
          </div>
        </>
      )}
    </Modal>
  );
}
