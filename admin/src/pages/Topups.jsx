// The top-up queue: what people asked for, in the order Kaho should look at it. Confirming one adds the minutes
// and tells the team; declining says why. A confirmation is final and cannot be done twice.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, post, qs } from "../api.js";
import { minutesText, rupees, TOPUP_WORDS } from "../../../frontend/src/billing.js";
import { serverView } from "../../../frontend/src/paginate.js";
import { Modal, Pager, Spinner, useToast, whenShort } from "../../../frontend/src/ui.jsx";
import { Head } from "../parts.jsx";

const FILTERS = [["pending", "Waiting"], ["paid", "Added"], ["rejected", "Not confirmed"], ["cancelled", "Withdrawn"], ["", "All"]];

export default function Topups() {
  const toast = useToast();
  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [d, setD] = useState(null);
  const [deciding, setDeciding] = useState(null); // { topup, approve }
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => get(`/topups${qs({ status, page, per_page: size })}`).then(setD).catch((e) => toast(e.message, true)), [status, page, size, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [status, size]);
  const decide = async () => {
    setBusy(true);
    try {
      await post(`/topups/${deciding.topup.id}/${deciding.approve ? "approve" : "reject"}`, { note });
      toast(deciding.approve ? `${minutesText(deciding.topup.minutes)} added.` : "Declined, and the team was told.");
      setDeciding(null); setNote(""); await load();
    } catch (e) { toast(e.message, true); await load(); } finally { setBusy(false); }
  };
  return (
    <section>
      <Head title="Top-ups" sub="Confirm a payment and the minutes are added at once. The team is told either way." />
      <div className="chips">
        {FILTERS.map(([id, label]) => <button key={id || "all"} type="button" className={`chip${status === id ? " on" : ""}`} onClick={() => setStatus(id)}>{label}</button>)}
      </div>
      <div className="card list">
        {!d ? <Spinner /> : d.topups.length === 0 ? <div className="empty">{status === "pending" ? "Nothing waiting. Every request has been dealt with." : "Nothing here."}</div> : (
          <div className="table-wrap"><table className="rows"><thead><tr><th>Asked</th><th>Organization</th><th>Minutes</th><th>Amount</th><th>Reference</th><th>Status</th><th /></tr></thead>
            <tbody>{d.topups.map((t) => (
              <tr key={t.id}><td>{whenShort(t.created_at)}<div className="hint">{t.requested_by}</div></td>
                <td><Link to={`/orgs/${t.org_id}`}>{t.org_name}</Link></td>
                <td>{minutesText(t.minutes)}<div className="hint">at {rupees(t.rate_paise)}/min</div></td>
                <td><b>{rupees(t.amount_paise)}</b></td><td className="code">{t.reference}</td>
                <td><span className={`pill ${t.status === "paid" ? "active" : t.status === "pending" ? "warn" : "muted"}`}>{TOPUP_WORDS[t.status]}</span>
                  {t.note && <div className="hint">{t.note}</div>}</td>
                <td>{t.status === "pending" && (
                  <div className="row-actions">
                    <button type="button" className="primary small-btn" onClick={() => { setDeciding({ topup: t, approve: true }); setNote(""); }}>Payment received</button>
                    <button type="button" className="ghost small-btn" onClick={() => { setDeciding({ topup: t, approve: false }); setNote(""); }}>Decline</button>
                  </div>)}</td></tr>))}</tbody></table></div>
        )}
      </div>
      {d && <Pager view={serverView({ page: d.page, total: d.total, size: d.per_page })} size={d.per_page} onPage={setPage} onSize={(x) => { setSize(x); setPage(1); }} />}
      {deciding && (
        <Modal title={deciding.approve ? "Payment received?" : "Decline this top-up?"} onClose={() => setDeciding(null)}>
          <p className="sub">{deciding.topup.org_name} asked for <b>{minutesText(deciding.topup.minutes)}</b> for <b>{rupees(deciding.topup.amount_paise)}</b>, reference <span className="code">{deciding.topup.reference}</span>.
            {deciding.approve ? " Only confirm once the money is in your account. The minutes are added now and cannot be taken back by pressing this again." : " They are told it was not confirmed."}</p>
          <div className="field"><label className="f" htmlFor="tp-note">{deciding.approve ? "Payment details (optional, shown to them)" : "Why (shown to them)"}</label>
            <input id="tp-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={deciding.approve ? "UPI reference" : "Payment not received"} autoFocus /></div>
          <div className="actions" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="ghost" onClick={() => setDeciding(null)}>Cancel</button>
            <button type="button" className={deciding.approve ? "primary" : "danger"} disabled={busy} onClick={decide}>{deciding.approve ? "Add the minutes" : "Decline"}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
