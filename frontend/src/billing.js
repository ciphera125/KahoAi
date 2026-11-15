// How money, minutes and plans are written on screen. Pure, so the Studio and the admin site say the same
// thing the same way. Money arrives as whole paise and time as whole minutes: nothing here is a float of rupees.
const IN = new Intl.NumberFormat("en-IN");

/** 549900 -> "₹5,499"; 137550 -> "₹1,375.50"; nothing -> "Custom". */
export function rupees(paise) {
  if (paise === null || paise === undefined || Number.isNaN(Number(paise))) return "Custom";
  const whole = Number(paise) % 100 === 0;
  return `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(Number(paise) / 100)}`;
}

/** 450 -> "₹4.5/min"; 500 -> "₹5/min". */
export function perMinute(paise) {
  if (paise === null || paise === undefined) return "Custom";
  return `₹${Number((paise / 100).toFixed(2))}/min`;
}

export const minutesText = (n) => (n === null || n === undefined ? "-" : `${IN.format(n)} min`);

export function logsText(days) {
  if (days === null || days === undefined) return "Custom";
  if (days >= 365 && days % 365 === 0) return `${days / 365} year${days === 365 ? "" : "s"}`;
  return `${days} days`;
}

/** The plan as the rate card prints it: label and value, in the card's order. */
export function planFacts(p) {
  return [
    ["Price per month", rupees(p.price_paise)],
    ["Minutes included", p.minutes_included === null ? "Custom" : IN.format(p.minutes_included)],
    ["About how many calls", p.approx_calls === null ? "Custom" : `~${IN.format(p.approx_calls)} calls`],
    ["Works out to", p.rate_paise === null ? "Custom" : `${p.rate_is_from ? "From " : ""}${perMinute(p.rate_paise)}`],
    ["Extra minutes", perMinute(p.extra_paise)],
    ["Simultaneous calls", p.simultaneous === null ? "Custom" : String(p.simultaneous)],
    ["Call logs kept", logsText(p.log_days)],
    ["Support", p.support || "-"],
    ["Languages", p.languages || "-"],
  ];
}

export const TOPUP_MIN = 50;
export const TOPUP_MAX = 20000;

/** What a top-up costs, or what is wrong with the number typed. The server checks again; this saves a round trip. */
export function topupQuote(minutes, extraPaise) {
  const n = typeof minutes === "string" && /^\d{1,6}$/.test(minutes.trim()) ? Number(minutes.trim()) : minutes;
  if (typeof n !== "number" || !Number.isInteger(n) || n < TOPUP_MIN || n > TOPUP_MAX) {
    return { ok: false, amount_paise: 0, text: `Choose a whole number of minutes from ${TOPUP_MIN} to ${IN.format(TOPUP_MAX)}.` };
  }
  if (extraPaise === null || extraPaise === undefined) return { ok: false, amount_paise: 0, text: "No price is set for extra minutes on your plan yet." };
  return { ok: true, amount_paise: n * extraPaise, text: rupees(n * extraPaise) };
}

const COPY = {
  subscription_required: { title: "Choose your plan", text: "Pick the plan that fits your calling. The Studio opens as soon as it is active." },
  subscription_pending: { title: "Waiting for payment to be confirmed", text: "You have chosen a plan. It starts as soon as Kaho confirms your payment." },
  subscription_expired: { title: "Your plan has ended", text: "Ask Kaho to renew it, and everything opens again exactly as you left it." },
  subscription_suspended: { title: "Your plan is suspended", text: "Contact Kaho to have it switched back on. Nothing has been deleted." },
};
export const lockCopy = (reason) => COPY[reason] ?? COPY.subscription_required;

export const STATUS_WORDS = { pending: "Waiting for payment", active: "Active", expired: "Ended", suspended: "Suspended", cancelled: "Cancelled" };
export const TOPUP_WORDS = { pending: "Waiting for Kaho", paid: "Added", rejected: "Not confirmed", cancelled: "Withdrawn" };
