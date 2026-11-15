// What organizations have asked Kaho for: plan changes and messages. Answer or dismiss each one; the answer shows up in their Studio.
import { useState } from "react";
import { post } from "../api.js";
import { Modal, Spinner, useToast } from "../../../frontend/src/ui.jsx";
import { Head, RequestCard, useServerPage } from "../parts.jsx";

const FILTERS = [["open", "Waiting"], ["done", "Answered"], ["dismissed", "Closed"]];

export default function Requests() {
  const toast = useToast();
  const [status, setStatus] = useState("open");
  const [d, pager, again] = useServerPage("/requests", { status });
  const [asking, setAsking] = useState(null);
  const [text, setText] = useState("");
  const send = async () => {
    try { await post(`/requests/${asking.r.id}`, { action: asking.action, response: text }); toast(asking.action === "done" ? "Answered." : "Closed."); setAsking(null); setText(""); window.dispatchEvent(new Event("kaho:admin-changed")); again(); }
    catch (e) { toast(e.message, true); again(); }
  };
  return (
    <section>
      <Head title="Requests" sub="What organizations have asked Kaho for. A plan change is changed from the organization's page; then mark it handled." />
      <div className="chips">{FILTERS.map(([id, label]) => <button key={id} type="button" className={`chip${status === id ? " on" : ""}`} onClick={() => setStatus(id)}>{label}</button>)}</div>
      {!d ? <Spinner /> : d.requests.length === 0 ? <div className="card"><div className="empty">Nothing here.</div></div> : (
        <div className="req-grid">{d.requests.map((r) => <RequestCard key={r.id} r={r} onAnswer={(req, action) => { setAsking({ r: req, action }); setText(""); }} />)}</div>
      )}
      {pager}
      {asking && (
        <Modal title={asking.action === "done" ? "Answer this request" : "Close this request"} onClose={() => setAsking(null)}>
          <div className="field"><label className="f" htmlFor="rq-ans">{asking.action === "done" ? "What do you want to tell them? (optional)" : "Why? (optional, they will see it)"}</label>
            <textarea id="rq-ans" rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} autoFocus /></div>
          <div className="actions" style={{ justifyContent: "flex-end" }}><button type="button" className="ghost" onClick={() => setAsking(null)}>Cancel</button>
            <button type="button" className="primary" onClick={send}>{asking.action === "done" ? "Send answer" : "Close request"}</button></div>
        </Modal>
      )}
    </section>
  );
}
