// Section building blocks for the home and features pages.
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "./Icon";
import { Button, WaveRule } from "./ui";
import type { Plan } from "../content/pricing";

/* ---------- Hero call card: an outgoing call ---------- */
type Turn = { who: "agent" | "customer"; text: string; hindi?: boolean };
export function CallCard({ label, status, turns }: { label: string; status: string; turns: Turn[] }) {
  return (
    <figure className="k-callcard k-card">
      <figcaption className="k-callcard-label">{label}</figcaption>
      <div className="k-callcard-top">
        <span className="k-callcard-icon"><Icon name="outgoing" size={20} /></span>
        <span className="k-callcard-who"><b>Outgoing call</b><small>{status}</small></span>
        <svg className="k-callcard-bars" viewBox="0 0 60 24" aria-hidden="true" focusable="false">
          {[6, 14, 20, 10, 16, 8, 12].map((h, i) => <rect key={i} x={i * 8 + 2} y={12 - h / 2} width="4" height={h} rx="2" style={{ animationDelay: `${i * 0.12}s` }} />)}
        </svg>
      </div>
      {turns.map((t, i) => (
        <div key={i} className={`k-turn k-turn-${t.who}`} style={{ animationDelay: `${0.5 + i * 0.5}s` }}>
          <span className="k-turn-who">{t.who === "agent" ? "Kaho agent" : "Customer"}</span>
          <p lang={t.hindi ? "hi" : undefined}>{t.text}</p>
        </div>
      ))}
    </figure>
  );
}

/* ---------- Before and after ---------- */
type Side = { label: string; text: string; tag: string };
export function BeforeAfter({ without, with: withKaho }: { without: Side; with: Side }) {
  return (
    <div className="k-ba">
      <article className="k-card k-ba-card k-ba-without">
        <div className="k-ba-head"><span className="k-ba-icon"><Icon name="phoneOff" /></span><h3>{without.label}</h3><span className="k-example">Example</span></div>
        <p>{without.text}</p>
        <span className="k-status k-status-bad"><i aria-hidden="true" />{without.tag}</span>
      </article>
      <article className="k-card k-ba-card k-ba-with">
        <div className="k-ba-head"><span className="k-ba-icon"><Icon name="outgoing" /></span><h3>{withKaho.label}</h3><span className="k-example">Example</span></div>
        <p>{withKaho.text}</p>
        <span className="k-status k-status-good"><i aria-hidden="true" />{withKaho.tag}</span>
      </article>
    </div>
  );
}

/* ---------- Agents ---------- */
export function AgentCard({ icon, title, text, tag }: { icon: IconName; title: string; text: string; tag: string }) {
  return (
    <article className="k-card k-agent">
      <span className="k-agent-icon"><Icon name={icon} size={28} /></span>
      <h3>{title}</h3>
      <p>{text}</p>
      <span className="k-chip">{tag}</span>
    </article>
  );
}

/* ---------- Steps ---------- */
export function StepList({ steps }: { steps: { title: string; text: string }[] }) {
  return (
    <div className="k-steps">
      <WaveRule className="k-steps-wave" />
      <ol>
        {steps.map((s, i) => (
          <li key={s.title} className="k-step">
            <span className="k-step-n" aria-hidden="true">{i + 1}</span>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------- Feature tiles ---------- */
export function FeatureTile({ icon, title }: { icon: IconName; title: string }) {
  return (
    <li className="k-tile">
      <span className="k-tile-icon"><Icon name={icon} /></span>
      <span>{title}</span>
    </li>
  );
}

/* ---------- Dashboard mock (TODO: swap for a real screenshot at public/brand/dashboard.png) ---------- */
type Row = { name: string; time: string; duration: string; outcome: string };
export function DashboardMock({ nav, rows, label }: { nav: string[]; rows: Row[]; label: string }) {
  return (
    <figure className="k-dash" aria-label={`Kaho dashboard, ${label.toLowerCase()}`}>
      <div className="k-dash-bar" aria-hidden="true"><i /><i /><i /><span>Kaho dashboard</span></div>
      <div className="k-dash-body">
        <ul className="k-dash-nav">
          {nav.map((n) => <li key={n} className={n === "Call logs" ? "is-on" : ""}>{n}</li>)}
        </ul>
        <div className="k-dash-main">
          <div className="k-dash-title"><b>Call logs</b><span className="k-dash-sample">{label}</span></div>
          <div className="k-dash-scroll">
            <table>
              <thead><tr><th scope="col">Contact</th><th scope="col">Time</th><th scope="col">Duration</th><th scope="col">Outcome</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name}><td>{r.name}</td><td>{r.time}</td><td>{r.duration}</td><td><span className="k-dash-out">{r.outcome}</span></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="k-dash-transcript" aria-hidden="true">
            <span>Transcript</span>
            <i style={{ width: "86%" }} /><i style={{ width: "64%" }} /><i style={{ width: "74%" }} />
          </div>
        </div>
      </div>
      <figcaption className="k-sr">{label}: three example rows, not real customers.</figcaption>
    </figure>
  );
}

/* ---------- Plans (no prices: pricing is shared on a call) ---------- */
const inr = (n: number) => n.toLocaleString("en-IN");
export function PlanCard({ plan, button }: { plan: Plan; button: string }) {
  const custom = plan.minutes === null;
  const rows: [string, string][] = custom
    ? [["Minutes and calls", "Sized to your volume"], ["At the same time", "As many as you need"], ["Support", plan.support]]
    : [
        ["Calls", `About ${inr(plan.calls!)} calls a month*`],
        ["At the same time", `${plan.concurrent} calls`],
        ["Call logs kept", `${plan.logs}`],
        ["Support", plan.support],
      ];
  return (
    <article className={`k-card k-plan${plan.highlight ? " is-hl" : ""}`}>
      <div className="k-plan-head">
        <h3>{plan.name}</h3>
        {plan.highlight && <span className="k-badge">Most chosen</span>}
      </div>
      <p className="k-plan-price">
        {custom ? <b>Custom</b> : <><b>{inr(plan.minutes!)}</b> <span>minutes a month</span></>}
      </p>
      <dl className="k-plan-rows">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <Button to={`/book-a-call?plan=${plan.name}`} variant={plan.highlight ? "primary" : "outline"} className="k-plan-btn">{button}</Button>
    </article>
  );
}

/* ---------- FAQ ---------- */
export function FaqItem({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  const id = useId();
  return (
    <div className={`k-faq-item${open ? " is-open" : ""}`}>
      <h3>
        <button type="button" id={`${id}-q`} aria-expanded={open} aria-controls={`${id}-a`} onClick={onToggle}>
          <span>{q}</span>
          <Icon name="plus" className="k-faq-icon" />
        </button>
      </h3>
      <div id={`${id}-a`} role="region" aria-labelledby={`${id}-q`} hidden={!open} className="k-faq-a">
        <p>{a}</p>
      </div>
    </div>
  );
}

export function Faq({ items }: { items: { q: string; a: string }[] }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="k-faq">
      {items.map((it, i) => <FaqItem key={it.q} {...it} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />)}
    </div>
  );
}

/* ---------- Closing band ---------- */
export function CtaBand({ title }: { title: string }) {
  return (
    <section className="k-cta" data-section="cta" aria-labelledby="k-cta-title">
      <span className="k-deva-mark" aria-hidden="true" lang="hi" data-mark="कहो" />
      <div className="k-container k-cta-in">
        <h2 id="k-cta-title" className="k-title">{title}</h2>
        <Button to="/book-a-call" variant="cta" arrow>Book a call</Button>
      </div>
    </section>
  );
}

/* ---------- Features page ---------- */
export function FeatureBlock({ title, text, art, flip, size }: { title: string; text: string; art: ArtName; flip: boolean; size: "wide" | "narrow" | "even" }) {
  return (
    <article className={`k-fblock k-fblock-${size}${flip ? " is-flip" : ""}`}>
      <div className="k-fblock-copy">
        <h2 className="k-fblock-title">{title}</h2>
        <p>{text}</p>
      </div>
      <div className="k-fblock-art k-card" aria-hidden="true"><FeatureArt name={art} /></div>
    </article>
  );
}

export type ArtName = "list" | "outgoing" | "booking" | "language" | "person" | "dashboard" | "number" | "setup";

function FeatureArt({ name }: { name: ArtName }) {
  switch (name) {
    case "list":
      return (
        <div className="k-art k-art-list">
          {["Contact 1", "Contact 2", "Contact 3", "Contact 4"].map((c, i) => (
            <div key={c} className="k-art-row"><Icon name="outgoing" size={18} /><span>{c}</span>
              {i < 3 ? <b className="k-art-ok"><Icon name="check" size={14} />Called</b> : <b className="k-art-next">Next</b>}</div>
          ))}
        </div>
      );
    case "outgoing":
      return (
        <div className="k-art k-art-list">
          {["Reminder", "Follow-up", "Lead call"].map((c) => (
            <div key={c} className="k-art-row"><Icon name="outgoing" size={18} /><span>{c}</span><b className="k-art-ok"><Icon name="check" size={14} />Logged</b></div>
          ))}
        </div>
      );
    case "booking":
      return (
        <div className="k-art k-art-cal">
          <div className="k-art-cal-head"><span>Tomorrow</span></div>
          <div className="k-art-slots">
            {["10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM", "12:00 PM", "12:30 PM"].map((t) => (
              <span key={t} className={t === "11:30 AM" ? "is-on" : t === "10:30 AM" || t === "12:00 PM" ? "is-taken" : ""}>{t}</span>
            ))}
          </div>
        </div>
      );
    case "language":
      return (
        <div className="k-art k-art-chat">
          <p className="k-art-bub" lang="hi">हाँ, कल सुबह ठीक रहेगा।</p>
          <p className="k-art-bub">Actually, can we make it a little later?</p>
          <p className="k-art-bub is-agent">Of course. How about 11:30 AM?</p>
        </div>
      );
    case "person":
      return (
        <div className="k-art k-art-talk">
          <div className="k-art-track"><span>Agent</span><svg viewBox="0 0 200 30" preserveAspectRatio="none"><path d="M0 15 Q10 3 20 15 T40 15 T60 15 T80 15 L120 15 L200 15" /></svg></div>
          <div className="k-art-track is-caller"><span>Customer</span><svg viewBox="0 0 200 30" preserveAspectRatio="none"><path d="M0 15 L80 15 Q90 3 100 15 T120 15 T140 15 T160 15 L200 15" /></svg></div>
          <p className="k-art-note">Agent pauses when the customer speaks</p>
        </div>
      );
    case "dashboard":
      return (
        <div className="k-art k-art-mini">
          <div className="k-art-mini-nav"><i /><i /><i /></div>
          <div className="k-art-mini-rows">{[1, 2, 3, 4].map((i) => <span key={i}><i /><i /><i /></span>)}</div>
        </div>
      );
    case "number":
      return (
        <div className="k-art k-art-connect">
          <span className="k-art-pill">Your number</span>
          <svg viewBox="0 0 120 24" className="k-art-link"><path d="M0 12 H120" /></svg>
          <span className="k-art-pill is-kaho">Kaho</span>
        </div>
      );
    case "setup":
      return (
        <div className="k-art k-art-setup">
          <div className="k-art-chips"><span>Services</span><span>Timings</span><span>Tone</span></div>
          <svg viewBox="0 0 24 24" className="k-art-down"><path d="M12 4v16M6 14l6 6 6-6" /></svg>
          <span className="k-art-pill is-kaho">Your agent</span>
        </div>
      );
  }
}

export function TextLink({ to, children }: { to: string; children: string }) {
  return <Link to={to} className="k-textlink">{children} <Icon name="arrow" size={18} /></Link>;
}
