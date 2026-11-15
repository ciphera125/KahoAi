import { useState, useSyncExternalStore, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useConfig } from "../config";
import { bookPage as p } from "../content/content";
import { PLAN_NAMES } from "../content/pricing";
import { BUSINESS_TYPES, bookingPayload, emptyBooking, isSafeHttpsUrl, mailtoHref, planFromSearch, validateBooking, type Booking, type Errors } from "../lib/validate";
import { Eyebrow, Section, Title } from "../components/ui";
import { Icon } from "../components/Icon";

export function BookACall() {
  const { bookingUrl } = useConfig();
  const embed = isSafeHttpsUrl(bookingUrl) ? bookingUrl : "";
  return (
    <Section name="book" tone="paper" className="k-book" labelledBy="k-h1">
      <div className="k-book-grid">
        <div className="k-book-copy">
          <Eyebrow>{p.eyebrow}</Eyebrow>
          <Title as="h1" id="k-h1" parts={p.title} />
          <ul className="k-points">
            {p.points.map((pt) => <li key={pt}><span><Icon name="check" size={18} /></span>{pt}</li>)}
          </ul>
        </div>
        <div className="k-book-side">{embed ? <BookingEmbed url={embed} /> : <BookingForm />}</div>
      </div>
    </Section>
  );
}

function BookingEmbed({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="k-card k-embed">
      {!loaded && <p className="k-embed-loading" role="status">Loading the booking calendar...</p>}
      <iframe src={url} title="Book a demo call" loading="lazy" onLoad={() => setLoaded(true)}
        referrerPolicy="strict-origin-when-cross-origin" />
    </div>
  );
}

type State = "idle" | "sending" | "sent" | "error";

function BookingForm() {
  const { formEndpoint, contactEmail } = useConfig();
  const endpoint = isSafeHttpsUrl(formEndpoint) ? formEndpoint : "";
  const { search } = useLocation();
  const [fields, setF] = useState<Booking>(emptyBooking);
  const [planChoice, setPlanChoice] = useState<string | null>(null); // null: not touched yet
  const [errors, setErrors] = useState<Errors>({});
  const [state, setState] = useState<State>("idle");

  // ?plan= prefills the plan. Read only once hydrated, so the prerendered page matches.
  const hydrated = useHydrated();
  const f: Booking = { ...fields, plan: planChoice ?? (hydrated ? planFromSearch(search) : "") };

  const set = (k: keyof Booking) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    if (k === "plan") setPlanChoice(e.target.value);
    else setF({ ...fields, [k]: e.target.value });
    if (errors[k]) setErrors({ ...errors, [k]: undefined });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validateBooking(f);
    setErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) {
      document.getElementById(`bk-${first}`)?.focus();
      return;
    }
    if (f.website) { setState("sent"); return; } // honeypot filled: a bot. Pretend it worked, send nothing.
    if (!endpoint) {
      window.location.href = mailtoHref(contactEmail, f);
      setState("sent");
      return;
    }
    setState("sending");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(bookingPayload(f)),
      });
      setState(res.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <div className="k-card k-form-done" role="status">
        <span className="k-form-done-icon"><Icon name="check" size={28} /></span>
        <h2 className="k-title k-title-sm">Thank you. We will be in touch soon.</h2>
        <p>{endpoint ? "Your request has reached us. We will call or email you to fix a time." : "Your email app should have opened with the details filled in. Please press send there."}</p>
      </div>
    );
  }

  const field = (k: keyof Booking, label: string, input: ReactNode, optional = false) => (
    <div className={`k-field${errors[k] ? " has-error" : ""}`}>
      <label htmlFor={`bk-${k}`}>{label}{optional && <span className="k-opt"> (optional)</span>}</label>
      {input}
      {errors[k] && <p className="k-error" id={`bk-${k}-err`}>{errors[k]}</p>}
    </div>
  );
  const aria = (k: keyof Booking) => ({ id: `bk-${k}`, name: k, "aria-invalid": Boolean(errors[k]) || undefined, "aria-describedby": errors[k] ? `bk-${k}-err` : undefined });

  return (
    <form className="k-card k-form" noValidate onSubmit={submit}>
      <div className="k-form-row">
        {field("name", "Your name", <input {...aria("name")} autoComplete="name" required value={f.name} onChange={set("name")} />)}
        {field("business", "Business name", <input {...aria("business")} autoComplete="organization" required value={f.business} onChange={set("business")} />)}
      </div>
      <div className="k-form-row">
        {field("phone", "Phone", <input {...aria("phone")} type="tel" inputMode="tel" autoComplete="tel" required value={f.phone} onChange={set("phone")} placeholder="10-digit mobile" />)}
        {field("email", "Email", <input {...aria("email")} type="email" autoComplete="email" required value={f.email} onChange={set("email")} />)}
      </div>
      <div className="k-form-row">
        {field("businessType", "Business type", (
          <select {...aria("businessType")} required value={f.businessType} onChange={set("businessType")}>
            <option value="">Choose one</option>
            {BUSINESS_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        ))}
        {field("plan", "Plan", (
          <select {...aria("plan")} value={f.plan} onChange={set("plan")}>
            <option value="">Not sure yet</option>
            {PLAN_NAMES.map((t) => <option key={t}>{t}</option>)}
          </select>
        ), true)}
      </div>
      {field("message", "Message", <textarea {...aria("message")} rows={4} value={f.message} onChange={set("message")} />, true)}
      <div className="k-hp" aria-hidden="true">
        <label htmlFor="bk-website">Leave this empty</label>
        <input id="bk-website" name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} />
      </div>
      {state === "error" && <p className="k-error k-form-err" role="alert">Sorry, that did not go through. Please try again, or write to {contactEmail}.</p>}
      <button type="submit" className="k-btn k-btn-primary k-form-submit" disabled={state === "sending"}>
        <span>{state === "sending" ? "Sending..." : "Request my demo call"}</span>
      </button>
    </form>
  );
}

const noop = () => () => {};
/** false while hydrating the prerendered page, true afterwards. */
function useHydrated() {
  return useSyncExternalStore(noop, () => true, () => false);
}
