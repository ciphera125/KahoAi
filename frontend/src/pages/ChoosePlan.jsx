// The first thing a new organization sees, and what any organization sees while its plan is not open: the rate
// card, one plan to choose, and where things stand. The Studio opens by itself the moment the plan is active.
import { useCallback, useEffect, useState } from "react";
import { get, post } from "../api.js";
import { can, useAuth } from "../auth.jsx";
import { lockCopy, planFacts, rupees } from "../billing.js";
import { OrgSwitcher } from "../components/Layout.jsx";
import { LogoMark, Wordmark } from "../logo.jsx";
import { startPolling } from "../poll.js";
import { Icon, Spinner, useToast } from "../ui.jsx";

export default function ChoosePlan() {
  const { me, refresh, signOut } = useAuth();
  const toast = useToast();
  const [plans, setPlans] = useState(null);
  const [overview, setOverview] = useState(null);
  const [busy, setBusy] = useState(null);
  const lock = me.billing;
  const copy = lockCopy(lock.reason);
  const allowed = can(me, "billing.manage");

  const load = useCallback(() => Promise.all([get("/api/plans"), get("/api/billing")])
    .then(([p, o]) => { setPlans(p); setOverview(o); }).catch((e) => toast(e.message, true)), [toast]);
  useEffect(() => { load(); }, [load]);
  // While the plan waits for payment to be confirmed, ask again now and then: the Studio opens by itself.
  useEffect(() => (lock.reason === "subscription_pending" ? startPolling(refresh, 15000) : undefined), [lock.reason, refresh]);

  const choose = async (plan) => {
    setBusy(plan.id);
    try {
      await post("/api/billing/subscribe", { plan_id: plan.id });
      toast(plan.custom ? `Thanks. Kaho will be in touch to set up ${plan.name}.` : `${plan.name} chosen. It starts when payment is confirmed.`);
      await refresh();
      await load();
    } catch (e) { toast(e.message, true); } finally { setBusy(null); }
  };

  return (
    <div className="plan-page">
      <header className="plan-top">
        <span className="plan-brand"><LogoMark size={34} /><b><Wordmark /></b></span>
        <span className="grow" />
        <span className="muted ellip">{me.name} · {me.org_name}</span>
        <OrgSwitcher />
        <button type="button" className="ghost" onClick={signOut}><Icon name="out" />Sign out</button>
      </header>
      <section className="plan-intro">
        <h1>{copy.title}</h1>
        <p className="sub">{copy.text}</p>
        {lock.reason === "subscription_pending" && overview && (
          <div className="banner info" role="status"><Icon name="clock" /><span>
            You chose <b>{lock.plan_name}</b>. {overview.how_to_pay ? overview.how_to_pay : "Kaho will contact you with the payment details."}
          </span></div>
        )}
        {!allowed && <div className="banner"><Icon name="warn" /><span>Only an admin of {me.org_name} can choose the plan. Ask them, or switch to another organization.</span></div>}
      </section>
      {lock.reason === "subscription_suspended" ? (
        <div className="card explain" style={{ maxWidth: 560, margin: "0 auto", textAlign: "center" }}>
          <b>Nothing has been deleted</b>
          <p className="hint">Your agents, contacts and call history are all still here. Contact Kaho and your plan can be switched back on.
            {overview?.how_to_pay ? ` ${overview.how_to_pay}` : ""}</p>
        </div>
      ) : !plans ? <Spinner /> : (
        <div className="plan-grid">
          {plans.map((p) => (
            <article key={p.id} className={`plan-card${p.highlighted ? " hot" : ""}${lock.plan_id === p.id && lock.status === "pending" ? " chosen" : ""}`}>
              <h2>{p.name}</h2>
              {p.highlighted && <span className="pill live">Most chosen</span>}
              <div className="plan-price">{p.custom ? "Custom" : <>{rupees(p.price_paise)}<span>/month</span></>}</div>
              <dl className="plan-facts">
                {planFacts(p).slice(1).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
              <button type="button" className={p.highlighted ? "primary" : "ghost"} disabled={!allowed || busy !== null || (lock.plan_id === p.id && lock.status === "pending")}
                onClick={() => choose(p)}>
                {busy === p.id ? "One moment…" : lock.plan_id === p.id && lock.status === "pending" ? "Chosen" : p.custom ? "Talk to us" : `Choose ${p.name}`}
              </button>
            </article>
          ))}
        </div>
      )}
      {lock.reason !== "subscription_suspended" && <p className="hint plan-foot">Pay for the calls you take. Unused minutes carry over to next month. Extra minutes are bought as top-ups at your plan's extra-minute price.</p>}
    </div>
  );
}
