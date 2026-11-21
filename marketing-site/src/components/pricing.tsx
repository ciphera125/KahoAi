// The Plans section of the home page. Words come from content/pricingCopy.ts, plans from content/plans.ts.
// No prices or rates appear anywhere on the public site; see plans.ts.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PLANS, planSpecs, formatMinutes, callsLine, type Plan } from "../content/plans";
import { PRICING } from "../content/pricingCopy";
import { offer } from "../config/offer.config";
import { track } from "../lib/track";
import { Eyebrow, Section, Title, type Tone } from "./ui";
import { FaqItem } from "./blocks";
import { Icon } from "./Icon";

export function PlanCard({ plan }: { plan: Plan }) {
  return (
    <article className={`k-pcard${plan.highlight ? " is-hl" : ""}`} aria-labelledby={`plan-${plan.name}`}>
      <div className="k-pcard-head">
        <h3 id={`plan-${plan.name}`}>{plan.name}</h3>
        {plan.highlight && <span className="k-badge">{PRICING.mostChosen}</span>}
      </div>
      <p className="k-pcard-who">{plan.forWho}</p>
      <p className="k-pcard-price">
        {plan.minutes === null
          ? <b className="k-pcard-custom">{PRICING.custom}</b>
          : <><b>{formatMinutes(plan.minutes)}</b> <span>{PRICING.perMonth}</span></>}
      </p>
      <p className="k-pcard-mins">{callsLine(plan)}</p>
      <ul className="k-specs">
        {planSpecs(plan).map(([label, value]) => (
          <li key={label}>
            <Icon name="check" size={16} className="k-spec-check" />
            <span className="k-spec-label">{label}</span>
            <span className="k-spec-value">{value}</span>
          </li>
        ))}
      </ul>
      <Link className="k-btn k-btn-primary k-pill k-pcard-btn" to={`/book-a-call?plan=${plan.name}`}
        onClick={() => track("book_call_clicked", { plan: plan.name, source: "plan_card" })}>
        <span>{plan.button}</span>
      </Link>
    </article>
  );
}

export function ValueStrip() {
  const items = [...PRICING.value.items, ...(offer.goLive ? [offer.goLive] : [])];
  return (
    <div className="k-value">
      <h3>{PRICING.value.title}</h3>
      <ul className="k-value-items">
        {items.map((it) => <li key={it.title}><h4>{it.title}</h4><p>{it.text}</p></li>)}
      </ul>
      {offer.guarantee && (
        <div className="k-guarantee"><h4>{offer.guarantee.title}</h4><p>{offer.guarantee.text}</p></div>
      )}
    </div>
  );
}

export function IncludedList() {
  return (
    <div className="k-included">
      <h3>{PRICING.included.title}</h3>
      <ul>
        {PRICING.included.items.map((t) => (
          <li key={t}><span className="k-inc-check"><Icon name="check" size={14} /></span>{t}</li>
        ))}
      </ul>
    </div>
  );
}

export function NotIncluded() {
  return (
    <div className="k-notinc">
      <h3>{PRICING.notIncluded.title}</h3>
      <ul>{PRICING.notIncluded.items.map((t) => <li key={t}>{t}</li>)}</ul>
    </div>
  );
}

export function BillingSteps() {
  return (
    <div className="k-bsteps">
      <h3>{PRICING.billing.title}</h3>
      <ol>
        {PRICING.billing.steps.map((s, i) => (
          <li key={s.title}>
            <span className="k-bstep-n" aria-hidden="true">{i + 1}</span>
            <h4>{s.title}</h4>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function BillingFaq() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="k-bfaq">
      <h3>{PRICING.billingFaq.title}</h3>
      <div className="k-faq k-faq-compact">
        {PRICING.billingFaq.items.map((it, i) => (
          <FaqItem key={it.q} {...it} level={4} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />
        ))}
      </div>
    </div>
  );
}

/** plans_viewed, once per page load, when the plan cards are at least 40% visible. */
function usePlansViewed(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        if (!(window as unknown as { __kPlansViewed?: boolean }).__kPlansViewed) {
          (window as unknown as { __kPlansViewed?: boolean }).__kPlansViewed = true;
          track("plans_viewed");
        }
        io.disconnect();
      }
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
}

export function PricingSection({ tone }: { tone: Tone }) {
  const cards = useRef<HTMLDivElement>(null);
  usePlansViewed(cards);
  return (
    <Section id="pricing" name="pricing" tone={tone} className="k-pricing" labelledBy="k-pr-t">
      <div className="k-head k-head-wide">
        <div><Eyebrow>{PRICING.eyebrow}</Eyebrow><Title id="k-pr-t" parts={PRICING.title} /></div>
        <p className="k-lede">{PRICING.sub}</p>
      </div>
      <div className="k-pcards" ref={cards}>{PLANS.map((p) => <PlanCard key={p.name} plan={p} />)}</div>
      <p className="k-pnote"><Icon name="info" size={18} /><span>{PRICING.note}</span></p>
      <ValueStrip />
      <div className="k-pextras">
        <IncludedList />
        <NotIncluded />
      </div>
      <div className="k-pbilling">
        <BillingSteps />
        <BillingFaq />
      </div>
      <p className="k-footnote">{PRICING.footnote}</p>
    </Section>
  );
}
