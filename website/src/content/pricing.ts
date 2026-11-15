// The plans shown on the site. No prices here on purpose: visitors book a call for pricing.

export type Plan = {
  name: "Start" | "Growth" | "Scale" | "Enterprise";
  minutes: number | null; // per month; null = custom
  calls: number | null; // at 2.5 minutes per call
  concurrent: number | null;
  logs: string | null;
  support: string;
  highlight?: boolean;
};

export const PLANS: Plan[] = [
  { name: "Start", minutes: 1100, calls: 440, concurrent: 2, logs: "30 days", support: "Email support" },
  { name: "Growth", minutes: 2000, calls: 800, concurrent: 5, logs: "90 days", support: "Email plus priority chat", highlight: true },
  { name: "Scale", minutes: 5500, calls: 2200, concurrent: 10, logs: "1 year", support: "Priority support plus an onboarding call" },
  { name: "Enterprise", minutes: null, calls: null, concurrent: null, logs: null, support: "Dedicated account manager" },
];

export const PLAN_NAMES = PLANS.map((p) => p.name);

export const PLANS_FOOTNOTE =
  "*Call counts assume an average call of 2.5 minutes. Unused minutes do not roll over. Phone number and telephony provider are arranged separately.";
