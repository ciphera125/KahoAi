// The rate card: what the next customer is sold. Changing a plan here never changes anyone already on it; to change
// one customer's own rates, open the organization.
import { useCallback, useEffect, useState } from "react";
import { get, patch } from "../api.js";
import { changed, TERM_FIELDS, toInput } from "../forms.js";
import { rupees } from "../../../frontend/src/billing.js";
import { Spinner, useToast } from "../../../frontend/src/ui.jsx";
import { Head } from "../parts.jsx";

const draftOf = (p) => ({ name: p.name, ...Object.fromEntries(TERM_FIELDS.map(([k, , kind]) => [k, toInput(kind, p[k])])) });

function PlanCard({ plan, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => draftOf(plan));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const flip = async (field) => {
    try { onSaved(await patch(`/plans/${plan.id}`, { [field]: !plan[field] })); toast("Saved."); } catch (e) { toast(e.message, true); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = changed(draft, plan);
      if (draft.name.trim() !== plan.name) body.name = draft.name.trim();
      if (!Object.keys(body).length) { toast("Nothing changed."); return; }
      const saved = await patch(`/plans/${plan.id}`, body);
      onSaved(saved); setDraft(draftOf(saved)); toast(`${saved.name} saved. Customers already on it keep their own terms.`);
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="card-head"><span className="card-title">{plan.name}{plan.custom ? " (terms set per customer)" : ""}</span>
        <span className="status-line">{plan.highlighted && <span className="pill live">Most chosen</span>}{!plan.active && <span className="pill failed">Hidden</span>}
          <span className="muted">{plan.custom ? "Custom" : `${rupees(plan.price_paise)}/month`}</span></span></div>
      <div className="terms-grid">
        <div className="field"><label className="f">Name</label><input value={draft.name} maxLength={40} onChange={set("name")} /></div>
        {TERM_FIELDS.map(([key, label, kind]) => (
          <div className="field" key={key}><label className="f" htmlFor={`${plan.id}-${key}`}>{label}</label>
            <input id={`${plan.id}-${key}`} value={draft[key]} inputMode={kind === "text" ? "text" : "decimal"} placeholder={plan.custom ? "Custom" : ""} onChange={set(key)} /></div>
        ))}
      </div>
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={save}>Save {plan.name}</button>
        <button type="button" className="ghost" onClick={() => flip("highlighted")}>{plan.highlighted ? "Not 'most chosen'" : "Mark 'most chosen'"}</button>
        <button type="button" className="ghost" onClick={() => flip("active")}>{plan.active ? "Hide from customers" : "Offer to customers"}</button>
      </div>
    </div>
  );
}

export default function Plans() {
  const toast = useToast();
  const [plans, setPlans] = useState(null);
  const load = useCallback(() => get("/plans").then(setPlans).catch((e) => toast(e.message, true)), [toast]);
  useEffect(() => { load(); }, [load]);
  if (!plans) return <Spinner />;
  return (
    <section>
      <Head title="Plans and rates" sub="The rate card customers choose from. A change here is for the next customer; people already on a plan keep the terms they were sold." />
      <div className="stack">{plans.map((p) => <PlanCard key={JSON.stringify(p)} plan={p} onSaved={load} />)}</div>
    </section>
  );
}
