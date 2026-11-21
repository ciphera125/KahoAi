// Settings, Billing: the plan this organization is on, the minutes it has left, asking for more, and where every
// minute went. A top-up is a request: the minutes are added when Kaho confirms the payment, and the whole team
// is told at each step, so nothing here ever shows minutes that are not there.
import { useCallback, useEffect, useState } from "react";
import { get, post } from "../api.js";
import { can, useMe } from "../auth.jsx";
import { logsText, minutesText, perMinute, planFacts, rupees, STATUS_WORDS, TOPUP_WORDS, topupQuote } from "../billing.js";
import { serverView } from "../paginate.js";
import { startPolling } from "../poll.js";
const bellAgain = () => window.dispatchEvent(new Event("kaho:notifications-changed"));
import { Icon, Pager, Spinner, useConfirm, useToast, whenShort, Info, usePaged } from "../ui.jsx";

const KIND_WORDS = { plan: "Plan minutes", topup: "Top-up", usage: "Call", adjust: "Adjustment by Kaho" };
const PILL = { active: "active", pending: "warn", expired: "failed", suspended: "failed", cancelled: "muted" };

export default function Billing() {
  const me = useMe();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [o, setO] = useState(null);
  const [topups, setTopups] = useState(null);
  const [plans, setPlans] = useState([]);
  const [minutes, setMinutes] = useState("250");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [moveTo, setMoveTo] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const manage = can(me, "billing.manage");

  const load = useCallback(async () => {
    try {
      const [overview, list] = await Promise.all([get("/api/billing"), get("/api/billing/topups")]);
      setO(overview); setTopups(list);
    } catch (e) { toast(e.message, true); }
  }, [toast]);
  useEffect(() => { load(); get("/api/plans").then(setPlans).catch(() => {}); }, [load]);
  // A confirmation from Kaho shows up here by itself.
  useEffect(() => startPolling(load, 20000), [load]);

  const [shownTopups, topupPager] = usePaged(topups ?? []);
  if (!o) return <Spinner />;
  const rate = o.terms?.extra_paise ?? null;
  const quote = topupQuote(minutes, rate);
  // The note about how to pay is for a request that is still waiting; once it is paid or withdrawn it goes.
  const waiting = fresh && topups?.find((t) => t.id === fresh.id && t.status === "pending") ? fresh : null;

  const request = async () => {
    if (!quote.ok) return toast(quote.text, true);
    setBusy(true);
    try {
      const t = await post("/api/billing/topups", { minutes });
      setFresh(t);
      toast("Top-up requested. The minutes are added when Kaho confirms payment.");
      bellAgain();
      await load();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  const withdraw = async (t) => {
    if (!(await confirm({ title: "Withdraw this top-up?", text: `The request for ${minutesText(t.minutes)} (${t.reference}) is cancelled. If you have already paid, contact Kaho first.`, ok: "Withdraw it" }))) return;
    try { await post(`/api/billing/topups/${t.id}/cancel`); toast("Top-up withdrawn."); bellAgain(); await load(); } catch (e) { toast(e.message, true); }
  };
  const ask = async () => {
    try {
      await post("/api/billing/change-request", { plan_id: moveTo, note: moveNote });
      toast("Thanks. Kaho will be in touch about changing your plan.");
      bellAgain();
      setMoveTo(""); setMoveNote(""); await load();
    } catch (e) { toast(e.message, true); }
  };

  const facts = o.terms ? planFacts({ price_paise: o.terms.price_paise ?? null, minutes_included: o.terms.minutes_included ?? null,
    approx_calls: o.terms.approx_calls ?? null, rate_paise: o.terms.rate_paise ?? null, rate_is_from: false, extra_paise: o.terms.extra_paise ?? null,
    simultaneous: o.terms.simultaneous ?? null, log_days: o.terms.log_days ?? null, support: o.terms.support, languages: o.terms.languages }) : [];
  const level = o.unmetered ? "ok" : o.level;

  return (
    <div className="stack">
      <div className={`card balance ${level}`}>
        <div>
          <span className="k">Minutes left</span>
          <div className="big-number">{o.unmetered ? "No limit" : minutesText(o.minutes_left)}</div>
          {!o.unmetered && o.level === "empty" && <p className="hint bad-text">You have no minutes left. New calls are refused until you top up.</p>}
          {!o.unmetered && o.level === "low" && <p className="hint">Running low. Top up so calls do not stop.</p>}
        </div>
        <dl className="settings-grid">
          <dt>Plan</dt><dd><span className={`plan-chip plan-${String(o.plan_id ?? "").replace(/[^a-z0-9]/g, "")}`}><Icon name="star" />{o.plan_name}</span> <span className={`pill ${PILL[o.status] ?? "muted"}`}>{STATUS_WORDS[o.status] ?? o.status}</span></dd>
          {o.period_end && <><dt>{o.status === "active" ? "Runs until" : "Ended"}</dt><dd>{new Date(o.period_end).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}</dd></>}
          {!o.unmetered && <><dt>Used this period</dt><dd>{minutesText(o.used_this_period)}</dd></>}
          <dt>Calls at once</dt><dd>{o.simultaneous ?? "-"}</dd>
        </dl>
      </div>

      {o.unmetered ? (
        <div className="card explain"><b>Your organization has no minute limit</b>
          <p className="hint">Kaho has set your plan up without counting minutes, so there is nothing to top up. Your calls are not limited by a balance.</p></div>
      ) : (
        <div className="card">
          <div className="card-head"><span className="card-title">Top up minutes</span></div>
          {!manage && <p className="hint">Only an admin can ask for a top-up.</p>}
          <p className="hint">An extra minute on your plan costs <b>{perMinute(rate)}</b>. Choose how many you want; the price is worked out here and the minutes are added when Kaho confirms your payment.</p>
          <div className="chips" role="group" aria-label="Quick amounts">
            {o.packs.map((p) => (
              <button key={p.minutes} type="button" className={`chip${String(p.minutes) === String(minutes) ? " on" : ""}`} disabled={!manage}
                onClick={() => setMinutes(String(p.minutes))}>{minutesText(p.minutes)} · {rupees(p.amount_paise)}</button>
            ))}
          </div>
          <div className="topup-row">
            <div className="field"><label className="f" htmlFor="tu-min">Minutes</label>
              <input id="tu-min" inputMode="numeric" value={minutes} disabled={!manage} onChange={(e) => setMinutes(e.target.value.replace(/[^\d]/g, "").slice(0, 6))} /></div>
            <div className="topup-price"><span className="k">You pay</span><b className={quote.ok ? "" : "muted"}>{quote.ok ? quote.text : "-"}</b></div>
            <button type="button" className="primary" disabled={!manage || busy || !quote.ok} onClick={request}><Icon name="plus" />Request top-up</button>
          </div>
          {!quote.ok && minutes !== "" && <p className="field-err">{quote.text}</p>}
          {(waiting || o.how_to_pay) && (
            <div className="banner info"><Icon name="clock" />
              <span>{o.how_to_pay ?? "Kaho will contact you with the payment details."}{waiting && <> Quote the reference <b className="code">{waiting.reference}</b> when you pay.</>}</span></div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-head"><span className="card-title">Your top-up requests</span></div>
        {!topups ? <Spinner /> : topups.length === 0 ? <p className="hint">No top-ups yet.</p> : (
          <table className="rows"><thead><tr><th>When</th><th>Minutes</th><th>Amount</th><th>Reference</th><th>Status</th><th /></tr></thead>
            <tbody>{shownTopups.map((t) => (
              <tr key={t.id}><td>{whenShort(t.created_at)}</td><td>{minutesText(t.minutes)}</td><td>{rupees(t.amount_paise)}</td><td className="code">{t.reference}</td>
                <td><span className={`pill ${t.status === "paid" ? "active" : t.status === "pending" ? "warn" : "muted"}`}>{TOPUP_WORDS[t.status]}</span>
                  {t.note && <div className="hint">{t.note}</div>}</td>
                <td>{t.status === "pending" && manage && <button type="button" className="ghost small-btn" onClick={() => withdraw(t)}>Withdraw</button>}</td></tr>))}</tbody></table>
        )}
        {topups && topups.length > 0 && (topupPager
        )}
      </div>

      <div className="card">
        <div className="card-head"><span className="card-title">Your plan's terms</span></div>
        <dl className="settings-grid">
          {facts.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        <p className="hint">These are the terms your organization was set up with. Call logs are kept {logsText(o.terms?.log_days ?? null)}.</p>
        {manage && plans.length > 0 && (
          <>
            <div className="f" style={{ marginTop: "var(--s4)" }}>Want a different plan?</div>
            {o.requested_plan_id && <p className="hint">You asked to move to <b>{plans.find((p) => p.id === o.requested_plan_id)?.name ?? o.requested_plan_id}</b>. Kaho will be in touch.</p>}
            <div className="topup-row">
              <div className="field"><label className="f" htmlFor="mv-plan">Plan</label>
                <select id="mv-plan" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                  <option value="">Choose a plan</option>
                  {plans.filter((p) => p.id !== o.plan_id).map((p) => <option key={p.id} value={p.id}>{p.name}{p.custom ? "" : ` · ${rupees(p.price_paise)}/month`}</option>)}
                </select></div>
              <div className="field"><label className="f" htmlFor="mv-note">Note (optional)</label>
                <input id="mv-note" maxLength={300} value={moveNote} onChange={(e) => setMoveNote(e.target.value)} placeholder="What you need" /></div>
              <button type="button" className="ghost" disabled={!moveTo} onClick={ask}>Ask Kaho to change it</button>
            </div>
          </>
        )}
      </div>

      <Ledger />
      {confirmNode}
    </div>
  );
}

/** Every minute that came in or went out, newest first. */
function Ledger() {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [d, setD] = useState(null);
  useEffect(() => { get(`/api/billing/ledger?page=${page}&per_page=${size}`).then(setD).catch((e) => toast(e.message, true)); }, [page, size, toast]);
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><span className="card-title">Where your minutes went</span></div>
        {!d ? <Spinner /> : d.entries.length === 0 ? <p className="hint">Nothing yet.</p> : (
          <div className="table-wrap"><table className="rows"><thead><tr><th>When</th><th>What</th><th>Who asked for it<Info text="The person in your team who requested the top-up or placed the call. An incoming call was started by the caller. Kaho AI confirms payments." /></th><th>Minutes</th></tr></thead>
            <tbody>{d.entries.map((e) => (
              <tr key={e.id}><td>{whenShort(e.at)}</td>
                <td>{KIND_WORDS[e.kind] ?? e.kind}{e.kind === "usage" && e.peer && <div className="hint">{e.direction === "inbound" ? "From" : "To"} {e.peer}</div>}{e.note && <div className="hint">{e.note}</div>}</td>
                <td>{e.requested_by ? <b>{e.requested_by}</b> : e.kind === "usage" && e.direction === "inbound" ? <span className="muted">The caller (incoming call)</span>
                  : e.kind === "usage" ? <span className="muted">An automatic or bulk call</span> : <span className="muted">-</span>}
                  {e.confirmed_by && <div className="hint">Confirmed by {e.confirmed_by}</div>}</td>
                <td className={`num ${e.minutes < 0 ? "minus" : "plus"}`}>{e.minutes > 0 ? "+" : ""}{e.minutes}</td></tr>))}</tbody></table></div>
        )}
      </div>
      {d && <Pager view={serverView({ page: d.page, total: d.total, size: d.per_page })} size={d.per_page} onPage={setPage} onSize={(n) => { setSize(n); setPage(1); }} />}
    </div>
  );
}
