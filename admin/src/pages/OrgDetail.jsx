// One organization, whole: its plan and the rates it was sold, its minutes, its people, its money, its call rules.
// Every change here is written to the admin record and told to the team it touches.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { del, get, patch, post } from "../api.js";
import { changed, fromInput, TERM_FIELDS, toInput } from "../forms.js";
import { minutesText, planFacts, rupees, TOPUP_WORDS } from "../../../frontend/src/billing.js";
import { Icon, Modal, Spinner, useConfirm, usePaged, useToast, whenShort, ago } from "../../../frontend/src/ui.jsx";
import { dateOf, Head, RequestCard, StatusPill, useServerPage } from "../parts.jsx";
import { TempPassword } from "./People.jsx";

const TABS = [["requests", "Requests"], ["plan", "Plan and rates"], ["people", "People"], ["money", "Money"], ["rules", "Call rules"], ["calls", "Recent calls"]];
const ROLES = ["admin", "manager", "builder", "operator", "viewer"];
const KIND = { plan: "Plan minutes", topup: "Top-up", usage: "Call", adjust: "Adjustment" };

export default function OrgDetail() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [d, setD] = useState(null);
  const [tab, setTab] = useState("plan");
  const [answering, setAnswering] = useState(null);
  const [answer, setAnswer] = useState("");
  const [naming, setNaming] = useState(null);
  const load = useCallback(() => get(`/orgs/${orgId}`).then(setD).catch((e) => { toast(e.message, true); if (e.status === 404) navigate("/orgs"); }), [orgId, toast, navigate]);
  useEffect(() => { setD(null); load(); }, [load]);
  if (!d) return <Spinner />;
  const sub = d.subscription;

  const act = async (title, text, ok, run, done) => {
    if (!(await confirm({ title, text, ok }))) return;
    try { await run(); toast(done); await load(); } catch (e) { toast(e.message, true); }
  };
  const rename = async () => {
    try { await patch(`/orgs/${orgId}`, { name: naming }); setNaming(null); toast("Renamed."); await load(); } catch (e) { toast(e.message, true); }
  };
  const status = (next, words) => act(`${words.title}?`, words.text, words.ok, () => post(`/orgs/${orgId}/status`, { status: next }), words.done);

  return (
    <section>
      <Link to="/orgs" className="back"><Icon name="back" />Organizations</Link>
      <Head title={d.org.name} sub={`${d.org.id} · created ${dateOf(d.org.created_at)}`}>
        <button type="button" className="ghost" onClick={() => setNaming(d.org.name)}><Icon name="pencil" />Rename</button>
        {sub?.status === "active" && <button type="button" className="ghost" onClick={() => status("suspended", { title: "Suspend this plan", ok: "Suspend", done: "Suspended.",
          text: "Everyone in this organization is locked out of the Studio and its bulk calls pause. Nothing is deleted, and you can switch it back on." })}>Suspend</button>}
        {sub && sub.status !== "active" && sub.status !== "pending" && <button type="button" className="primary" onClick={() => status("active", { title: "Switch the plan back on", ok: "Switch on", done: "Switched on.",
          text: "The Studio opens again for everyone in this organization. If its month has ended it stays ended until you renew it." })}>Switch on</button>}
      </Head>

      <div className="kpis six">
        <div className="kpi"><span className="k">Plan</span><span className="v">{sub?.plan_name ?? "None"}</span><StatusPill status={sub?.status} unmetered={sub?.unmetered} /></div>
        <div className="kpi"><span className="k">Minutes left</span><span className="v">{!sub ? "-" : sub.unmetered ? "No limit" : minutesText(sub.balance_minutes)}</span></div>
        <div className="kpi"><span className="k">Used, 30 days</span><span className="v">{minutesText(d.counts.minutes_30d)}</span><span className="muted">{d.counts.calls_30d} {d.counts.calls_30d === 1 ? "call" : "calls"}</span></div>
        <div className="kpi"><span className="k">People</span><span className="v">{d.members.length}</span></div>
        <div className="kpi"><span className="k">Agents · numbers</span><span className="v">{d.counts.agents} · {d.counts.numbers}</span></div>
        <div className="kpi"><span className="k">Runs until</span><span className="v" style={{ fontSize: 18 }}>{sub?.unmetered ? "No end" : dateOf(sub?.period_end)}</span></div>
      </div>
      {d.requests.some((r) => r.status === "open") && (
        <div className="banner warn"><Icon name="clock" /><span><b>{d.requests.filter((r) => r.status === "open").length} request{d.requests.filter((r) => r.status === "open").length === 1 ? "" : "s"} waiting.</b></span>
          <button type="button" className="ghost small-btn" onClick={() => setTab("requests")}>See them</button></div>
      )}

      <div className="seg">{TABS.map(([id, label]) => <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>)}</div>

      {tab === "requests" && (
        <div className="stack">
          {d.requests.length === 0 ? <div className="card"><div className="empty">This organization has not asked for anything.</div></div>
            : <div className="req-grid">{d.requests.map((r) => <RequestCard key={r.id} r={{ ...r, org_id: orgId, org_name: d.org.name, current_plan_name: sub?.plan_name }} showOrg={false}
              onAnswer={(req, action) => { setAnswering({ r: req, action }); setAnswer(""); }} />)}</div>}
        </div>
      )}
      {tab === "plan" && <PlanTab d={d} orgId={orgId} reload={load} act={act} />}
      {tab === "people" && <PeopleTab d={d} orgId={orgId} reload={load} act={act} confirm={confirm} />}
      {tab === "money" && <MoneyTab d={d} reload={load} />}
      {tab === "rules" && <RulesTab d={d} orgId={orgId} reload={load} />}
      {tab === "calls" && <CallsTab d={d} />}

      {answering && (
        <Modal title={answering.action === "done" ? "Answer this request" : "Close this request"} onClose={() => setAnswering(null)}>
          <div className="field"><label className="f" htmlFor="rq-ans">{answering.action === "done" ? "What do you want to tell them? (optional)" : "Why? (optional, they will see it)"}</label>
            <textarea id="rq-ans" rows={3} maxLength={500} value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus /></div>
          <div className="actions" style={{ justifyContent: "flex-end" }}><button type="button" className="ghost" onClick={() => setAnswering(null)}>Cancel</button>
            <button type="button" className="primary" onClick={async () => {
              try { await post(`/requests/${answering.r.id}`, { action: answering.action, response: answer }); toast("Done."); setAnswering(null); window.dispatchEvent(new Event("kaho:admin-changed")); await load(); }
              catch (e) { toast(e.message, true); await load(); }
            }}>Send</button></div>
        </Modal>
      )}
      {naming !== null && (
        <Modal title="Rename organization" onClose={() => setNaming(null)}>
          <div className="field"><label className="f" htmlFor="org-name">Name</label>
            <input id="org-name" value={naming} maxLength={80} onChange={(e) => setNaming(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && rename()} /></div>
          <div className="actions" style={{ justifyContent: "flex-end" }}><button type="button" className="ghost" onClick={() => setNaming(null)}>Cancel</button>
            <button type="button" className="primary" onClick={rename}>Save</button></div>
        </Modal>
      )}
      {confirmNode}
    </section>
  );
}

// --- plan and rates ---------------------------------------------------------------------------

function PlanTab({ d, orgId, reload, act }) {
  const sub = d.subscription;
  const [plans, setPlans] = useState([]);
  useEffect(() => { get("/plans").then(setPlans).catch(() => {}); }, []);

  return (
    <div className="stack">
      <AssignPlan sub={sub} plans={plans} orgId={orgId} reload={reload} />
      {sub && <TermsEditor sub={sub} orgId={orgId} reload={reload} />}
      {sub && (
        <div className="cols">
          <MinutesForm orgId={orgId} reload={reload} balance={sub.unmetered ? null : sub.balance_minutes} />
          <div className="card">
            <div className="card-head"><span className="card-title">This month</span></div>
            <div className="row-actions">
              <button type="button" className="ghost" disabled={sub.unmetered} onClick={() => act("Renew for another month?",
                `Adds ${minutesText(sub.terms.minutes_included ?? 0)} and moves the end of the month on. Unused minutes carry over. Only renew once the payment is in.`, "Renew",
                () => post(`/orgs/${orgId}/renew`), "Renewed.")}>Renew for a month</button>
              <button type="button" className="ghost" onClick={() => act(sub.unmetered ? "Start counting minutes?" : "Stop counting minutes?",
                sub.unmetered ? "Their calls will use up the balance, and calls are refused when it reaches zero." : "Their calls are no longer limited by a balance. Use this for trials, internal teams or special arrangements.",
                "Yes", () => post(`/orgs/${orgId}/unmetered`, { unmetered: !sub.unmetered }), "Done.")}>{sub.unmetered ? "Count minutes" : "No minute limit"}</button>
              {sub.status !== "cancelled" && <button type="button" className="ghost danger-text" onClick={() => act("Cancel this plan?",
                "The Studio locks for everyone in this organization. They can choose a plan again. Nothing is deleted.", "Cancel the plan",
                () => post(`/orgs/${orgId}/status`, { status: "cancelled" }), "Cancelled.")}>Cancel plan</button>}
            </div>
            {sub.note && <p className="hint">{sub.note}</p>}
            <p className="hint">{sub.activated_at ? `Started ${dateOf(sub.activated_at)} by ${sub.activated_by}.` : "Not started yet."}</p>
          </div>
        </div>
      )}
      {!sub && <div className="card explain"><b>No plan chosen yet</b><p className="hint">This organization has not picked a plan, so its Studio is locked. Choose one above to open it.</p></div>}
    </div>
  );
}

function AssignPlan({ sub, plans, orgId, reload }) {
  const toast = useToast();
  const [planId, setPlanId] = useState("");
  const [typed, setTyped] = useState({});
  const [grant, setGrant] = useState(true);
  const [unmetered, setUnmetered] = useState(false);
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const plan = plans.find((p) => p.id === planId);
  useEffect(() => {
    if (plan) setTyped(Object.fromEntries(TERM_FIELDS.map(([k, , kind]) => [k, toInput(kind, plan[k])])));
    // Add the plan's minutes by default unless the organization is already counting minutes in a month (a grandfathered
    // "no limit" organization is not: moving it onto a plan has to give it its minutes).
    setGrant(!(sub?.status === "active" && !sub.unmetered && sub.period_end));
  }, [plan, sub?.status, sub?.unmetered, sub?.period_end]);

  const submit = async () => {
    setBusy(true);
    try {
      const terms = {};
      for (const [key, , kind] of TERM_FIELDS) {
        const v = fromInput(kind, typed[key] ?? "", { empty: true });
        if (v !== null) terms[key] = v;
      }
      const body = { plan_id: planId, terms, unmetered, grant_included: grant };
      if (end) body.period_end = new Date(`${end}T23:59:59+05:30`).toISOString();
      await post(`/orgs/${orgId}/plan`, body);
      toast(`${plan.name} started.`);
      setPlanId(""); await reload();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-head"><span className="card-title">{sub ? "Move to another plan, or start it" : "Put on a plan"}</span></div>
      <p className="hint">Starting a plan opens the Studio for everyone in this organization. Do it once the payment is in, or to give someone a plan on purpose.</p>
      <div className="field"><label className="f" htmlFor="as-plan">Plan</label>
        <select id="as-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
          <option value="">Choose a plan</option>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.custom ? " (set the terms below)" : ` · ${rupees(p.price_paise)}/month`}{p.active ? "" : " · hidden"}</option>)}
        </select></div>
      {plan && (
        <>
          <p className="hint">The terms below start from the rate card; change any of them for this customer only.{plan.custom ? " Fill in every number for a custom plan." : ""}</p>
          <div className="terms-grid">
            {TERM_FIELDS.map(([key, label, kind]) => (
              <div className="field" key={key}><label className="f" htmlFor={`as-${key}`}>{label}</label>
                <input id={`as-${key}`} value={typed[key] ?? ""} inputMode={kind === "text" ? "text" : "decimal"} onChange={(e) => setTyped((t) => ({ ...t, [key]: e.target.value }))} /></div>
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} /><span>Add the plan's monthly minutes now</span></label>
          <label className="check"><input type="checkbox" checked={unmetered} onChange={(e) => setUnmetered(e.target.checked)} /><span>No minute limit (do not count minutes)</span></label>
          <div className="field" style={{ maxWidth: 260, marginTop: "var(--s3)" }}><label className="f" htmlFor="as-end">Runs until (optional)</label>
            <input id="as-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /><span className="hint">Leave empty for one month from today.</span></div>
          <div className="actions"><button type="button" className="primary" disabled={busy} onClick={submit}>Start {plan.name}</button></div>
        </>
      )}
    </div>
  );
}

function TermsEditor({ sub, orgId, reload }) {
  const toast = useToast();
  const start = useCallback(() => Object.fromEntries(TERM_FIELDS.map(([k, , kind]) => [k, toInput(kind, sub.terms[k])])), [sub.terms]);
  const [typed, setTyped] = useState(start);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTyped(start()); }, [start]);
  const save = async () => {
    setBusy(true);
    try {
      const terms = changed(typed, sub.terms);
      if (!Object.keys(terms).length) { toast("Nothing changed."); return; }
      await patch(`/orgs/${orgId}/terms`, { terms });
      toast("Saved. It applies from now: top-ups, calls at once and the rest follow it."); await reload();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  const facts = planFacts({ ...Object.fromEntries(TERM_FIELDS.map(([k]) => [k, sub.terms[k] ?? null])), rate_is_from: false });
  return (
    <div className="card">
      <div className="card-head"><span className="card-title">This customer's own rates</span><span className="muted">{facts[3][1]} · extra {facts[4][1]}</span></div>
      <p className="hint">What this organization was sold. Change a number to change it for this customer only. The price of an extra minute is what a top-up costs them.</p>
      <div className="terms-grid">
        {TERM_FIELDS.map(([key, label, kind]) => (
          <div className="field" key={key}><label className="f" htmlFor={`tm-${key}`}>{label}</label>
            <input id={`tm-${key}`} value={typed[key] ?? ""} inputMode={kind === "text" ? "text" : "decimal"} onChange={(e) => setTyped((t) => ({ ...t, [key]: e.target.value }))} /></div>
        ))}
      </div>
      <div className="actions"><button type="button" className="primary" disabled={busy} onClick={save}>Save these rates</button></div>
    </div>
  );
}

function MinutesForm({ orgId, reload, balance }) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (sign) => {
    const n = Number(amount);
    if (!/^\d{1,7}$/.test(amount) || n < 1) return toast("Type a whole number of minutes.", true);
    setBusy(true);
    try {
      await post(`/orgs/${orgId}/minutes`, { minutes: sign * n, note });
      toast(sign > 0 ? "Minutes added. The team has been told." : "Minutes removed. The team has been told.");
      setAmount(""); setNote(""); await reload();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="card-head"><span className="card-title">Add or remove minutes</span><span className="muted">{balance === null ? "No limit" : `${minutesText(balance)} now`}</span></div>
      <p className="hint">For goodwill, a correction, or a payment taken another way. The reason is shown to them with the new balance.</p>
      <div className="field"><label className="f" htmlFor="mn-n">Minutes</label><input id="mn-n" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 7))} /></div>
      <div className="field"><label className="f" htmlFor="mn-note">Reason</label><input id="mn-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Goodwill for the outage" /></div>
      <div className="actions"><button type="button" className="primary" disabled={busy} onClick={() => submit(1)}>Add</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => submit(-1)}>Remove</button></div>
    </div>
  );
}

// --- people -----------------------------------------------------------------------------------

function PeopleTab({ d, orgId, reload, act, confirm }) {
  const toast = useToast();
  const [fresh, setFresh] = useState(null);
  const [support, setSupport] = useState(null);
  const [shownMembers, memberPager] = usePaged(d.members);

  const role = async (m, next) => {
    try { await patch(`/orgs/${orgId}/members/${m.id}`, { role: next }); toast(`${m.name} is now ${next}.`); await reload(); } catch (e) { toast(e.message, true); }
  };
  const open = async () => {
    try {
      const r = await post(`/orgs/${orgId}/impersonate`, { user_id: support.id });
      window.open(r.url, "_blank", "noopener");
      toast(`Opened the Studio as ${r.person} in a new tab. The link works once.`);
      setSupport(null);
    } catch (e) { toast(e.message, true); setSupport(null); }
  };
  const reset = async (m) => {
    if (!(await confirm({ title: `Reset ${m.name}'s password?`, text: "A temporary password is shown once. Their sessions end now.", ok: "Reset it" }))) return;
    try { setFresh(await post(`/users/${m.id}/reset-password`)); } catch (e) { toast(e.message, true); }
  };
  return (
    <div className="card list">
      <div className="table-wrap"><table className="rows"><thead><tr><th>Person</th><th>Role</th><th>Last signed in</th><th>Account</th><th /></tr></thead>
        <tbody>{shownMembers.map((m) => (
          <tr key={m.id}><td><b>{m.name}</b><div className="hint">{m.email}</div></td>
            <td>{(
              <select value={m.role} aria-label={`Role of ${m.name}`} onChange={(e) => role(m, e.target.value)} style={{ width: 150 }}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>)}</td>
            <td>{m.last_login_at ? ago(m.last_login_at) : "never"}</td>
            <td><span className={`pill ${m.disabled ? "failed" : "active"}`}>{m.disabled ? "Switched off" : "On"}</span></td>
            <td><div className="row-actions">
              <button type="button" className="ghost small-btn" disabled={m.disabled} onClick={() => setSupport(m)}>Open Studio as</button>
              <button type="button" className="ghost small-btn" onClick={async () => { try { await post(`/users/${m.id}/${m.disabled ? "enable" : "disable"}`); await reload(); } catch (e) { toast(e.message, true); } }}>{m.disabled ? "Switch on" : "Switch off"}</button>
              <button type="button" className="ghost small-btn" onClick={() => reset(m)}>Reset password</button>
              {<button type="button" className="ghost small-btn danger-text" onClick={() => act(`Remove ${m.name}?`, "They lose access to this organization at once. If it was their only one, their account is deleted.", "Remove",
                () => del(`/orgs/${orgId}/members/${m.id}`), "Removed.")}>Remove</button>}
            </div></td></tr>))}</tbody></table></div>
      {memberPager}
      {fresh && <TempPassword who={fresh} onClose={() => setFresh(null)} />}
      {support && (
        <Modal title={`Open the Studio as ${support.name}?`} onClose={() => setSupport(null)}>
          <p className="sub">A new tab opens with the Studio signed in as <b>{support.name}</b>, for up to two hours. You will see and can change what they can.
            It is not invisible: their team is told Kaho support signed in, it is in their audit log, anything changed is marked as support, and it is in the admin record under your name.
            Passwords cannot be changed from it.</p>
          <div className="actions" style={{ justifyContent: "flex-end" }}><button type="button" className="ghost" onClick={() => setSupport(null)}>Cancel</button>
            <button type="button" className="primary" onClick={open}>Open the Studio</button></div>
        </Modal>
      )}
    </div>
  );
}

// --- money ------------------------------------------------------------------------------------

function MoneyTab({ d, reload }) {
  const toast = useToast();
  const orgId = d.org.id;
  const [tops, topPager, topAgain] = useServerPage("/topups", { org: orgId });
  const [led, ledPager, ledAgain] = useServerPage(`/orgs/${orgId}/ledger`);
  const [deciding, setDeciding] = useState(null);
  const [note, setNote] = useState("");
  const decide = async () => {
    try {
      await post(`/topups/${deciding.t.id}/${deciding.approve ? "approve" : "reject"}`, { note });
      toast(deciding.approve ? "Minutes added." : "Declined."); setDeciding(null); setNote(""); await reload(); topAgain(); ledAgain();
    } catch (e) { toast(e.message, true); await reload(); topAgain(); }
  };
  return (
    <div className="stack">
      <div className="card list">
        <div className="card-head" style={{ padding: "var(--s4) var(--s4) 0" }}><span className="card-title">Top-up requests</span></div>
        {!tops ? <Spinner /> : tops.topups.length === 0 ? <div className="empty">None yet.</div> : (
          <div className="table-wrap"><table className="rows"><thead><tr><th>Asked</th><th>Minutes</th><th>Amount</th><th>Reference</th><th>Status</th><th /></tr></thead>
            <tbody>{tops.topups.map((t) => (
              <tr key={t.id}><td>{whenShort(t.created_at)}</td><td>{minutesText(t.minutes)}</td><td><b>{rupees(t.amount_paise)}</b></td><td className="code">{t.reference}</td>
                <td><span className={`pill ${t.status === "paid" ? "active" : t.status === "pending" ? "warn" : "muted"}`}>{TOPUP_WORDS[t.status]}</span>{t.note && <div className="hint">{t.note}</div>}</td>
                <td>{t.status === "pending" && <div className="row-actions"><button type="button" className="primary small-btn" onClick={() => setDeciding({ t, approve: true })}>Payment received</button>
                  <button type="button" className="ghost small-btn" onClick={() => setDeciding({ t, approve: false })}>Decline</button></div>}</td></tr>))}</tbody></table></div>
        )}
      </div>
      <div className="card list">
        <div className="card-head" style={{ padding: "var(--s4) var(--s4) 0" }}><span className="card-title">Minute ledger</span></div>
        {!led ? <Spinner /> : led.entries.length === 0 ? <div className="empty">No movement yet.</div> : (
          <div className="table-wrap"><table className="rows"><thead><tr><th>When</th><th>What</th><th>Minutes</th></tr></thead>
            <tbody>{led.entries.map((l) => (
              <tr key={l.id}><td>{whenShort(l.at)}</td><td>{KIND[l.kind] ?? l.kind}{l.note && <div className="hint">{l.note}</div>}{l.call_id && <div className="hint code">{l.call_id}</div>}</td>
                <td className={`num ${l.minutes < 0 ? "minus" : "plus"}`}>{l.minutes > 0 ? "+" : ""}{l.minutes}</td></tr>))}</tbody></table></div>
        )}
      </div>
      {topPager}{ledPager}
      {deciding && (
        <Modal title={deciding.approve ? "Payment received?" : "Decline this top-up?"} onClose={() => setDeciding(null)}>
          <p className="sub"><b>{minutesText(deciding.t.minutes)}</b> for <b>{rupees(deciding.t.amount_paise)}</b>, reference <span className="code">{deciding.t.reference}</span>.</p>
          <div className="field"><label className="f" htmlFor="md-note">{deciding.approve ? "Payment details (optional)" : "Why (shown to them)"}</label>
            <input id="md-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} autoFocus /></div>
          <div className="actions" style={{ justifyContent: "flex-end" }}><button type="button" className="ghost" onClick={() => setDeciding(null)}>Cancel</button>
            <button type="button" className={deciding.approve ? "primary" : "danger"} onClick={decide}>{deciding.approve ? "Add the minutes" : "Decline"}</button></div>
        </Modal>
      )}
    </div>
  );
}

// --- call rules -------------------------------------------------------------------------------

function RulesTab({ d, orgId, reload }) {
  const toast = useToast();
  const s = d.settings;
  const [max, setMax] = useState(s?.max_minutes ?? "");
  const [w, setW] = useState(s?.call_window ?? { enabled: false, start: "09:00", end: "21:00", timezone: "Asia/Kolkata" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await patch(`/orgs/${orgId}/settings`, { max_minutes: max === "" ? null : Number(max), call_window: w });
      toast("Saved. The team has been told."); await reload();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="card-head"><span className="card-title">Call rules for everyone in this organization</span></div>
      <p className="hint">The same rules the organization's own admins can set in Settings. They hold for every agent and every call.</p>
      <div className="toggle-line"><div><b>Only call during certain hours</b><div className="hint">TRAI allows commercial calls 09:00 to 21:00.</div></div>
        <label className="switch"><input type="checkbox" checked={w.enabled} onChange={(e) => setW({ ...w, enabled: e.target.checked })} /><span /></label></div>
      <div className="grid-2">
        <div className="field"><label className="f">From</label><input type="time" value={w.start} disabled={!w.enabled} onChange={(e) => setW({ ...w, start: e.target.value })} /></div>
        <div className="field"><label className="f">To</label><input type="time" value={w.end} disabled={!w.enabled} onChange={(e) => setW({ ...w, end: e.target.value })} /></div>
      </div>
      <div className="field"><label className="f">Time zone</label><input value={w.timezone} disabled={!w.enabled} onChange={(e) => setW({ ...w, timezone: e.target.value })} /></div>
      <div className="field" style={{ maxWidth: 260 }}><label className="f">Longest any call can be (minutes)</label>
        <input type="number" min={1} max={30} value={max} placeholder="No limit" onChange={(e) => setMax(e.target.value)} /></div>
      <div className="actions"><button type="button" className="primary" disabled={busy} onClick={save}>Save call rules</button></div>
    </div>
  );
}

function CallsTab({ d }) {
  const [c, pager] = useServerPage(`/orgs/${d.org.id}/calls`);
  return (
    <div className="stack"><div className="card list">
      {!c ? <Spinner /> : c.calls.length === 0 ? <div className="empty">No calls yet.</div> : (
        <div className="table-wrap"><table className="rows"><thead><tr><th>Started</th><th>Direction</th><th>Number</th><th>Outcome</th><th>Length</th></tr></thead>
          <tbody>{c.calls.map((c) => (
            <tr key={c.call_id}><td>{whenShort(c.started_at)}</td><td>{c.direction ?? "-"}</td><td className="code">{c.peer ?? "-"}</td><td>{c.status ?? "-"}</td>
              <td>{c.duration_secs ? `${Math.floor(c.duration_secs / 60)}:${String(c.duration_secs % 60).padStart(2, "0")}` : "-"}</td></tr>))}</tbody></table></div>
      )}
      <p className="hint" style={{ padding: "0 var(--s4) var(--s4)" }}>Numbers are shown with all but the last four digits hidden. To see a call in full, open the Studio as someone in the team.</p>
    </div>{pager}</div>
  );
}
