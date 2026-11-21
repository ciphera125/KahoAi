// The four plans. Minutes and spec rows only: prices, per-minute rates and extra-minute
// rates are NOT part of the public site and must never be added here. They are shared on a call.

export type PlanName = "Start" | "Growth" | "Scale" | "Enterprise";

export type Plan = {
  name: PlanName;
  forWho: string;
  minutes: number | null; // per month; null = custom
  calls: number | null; // at 2.5 minutes per call
  concurrent: string;
  logs: string;
  support: string;
  extra: string;
  button: string;
  highlight?: boolean;
  // These can never be added back by accident: the compiler rejects any value.
  price?: never;
  rate?: never;
  extraRate?: never;
};

const SET_WITH_US = "Set with us";
const AUTO = "Added automatically";

export const PLANS: Plan[] = [
  {
    name: "Start", forWho: "For a single clinic, salon or small service desk.",
    minutes: 1100, calls: 440, concurrent: "2 calls", logs: "30 days", support: "Email support", extra: AUTO, button: "Book a call",
  },
  {
    name: "Growth", forWho: "For a busy front desk that takes calls every day.",
    minutes: 2000, calls: 800, concurrent: "5 calls", logs: "90 days", support: "Email plus priority chat support", extra: AUTO, button: "Book a call", highlight: true,
  },
  {
    name: "Scale", forWho: "For several branches or high call volume.",
    minutes: 5500, calls: 2200, concurrent: "10 calls", logs: "1 year", support: "Priority support plus an onboarding call", extra: AUTO, button: "Book a call",
  },
  {
    name: "Enterprise", forWho: "For large teams with custom needs.",
    minutes: null, calls: null, concurrent: SET_WITH_US, logs: SET_WITH_US, support: "Dedicated account manager", extra: SET_WITH_US, button: "Talk to us",
  },
];

export const PLAN_NAMES: PlanName[] = PLANS.map((p) => p.name);

const inr = (n: number) => n.toLocaleString("en-IN");
export const formatMinutes = (n: number) => inr(n);
export const callsLine = (p: Plan) => (p.calls === null ? "Custom minutes" : `About ${inr(p.calls)} calls*`);

export const SPEC_LABELS = ["Calls at the same time", "Call log history", "Support", "Extra minutes"] as const;

/** The spec rows for a card, always in SPEC_LABELS order so rows line up across cards. */
export function planSpecs(p: Plan): [string, string][] {
  const values = [p.concurrent, p.logs, p.support, p.extra];
  return SPEC_LABELS.map((label, i) => [label, values[i]]);
}
