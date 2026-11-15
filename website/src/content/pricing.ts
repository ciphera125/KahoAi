// All pricing on the site comes from here. Prices exclude GST.

export type Plan = {
  name: "Start" | "Growth" | "Scale" | "Enterprise";
  price: number | null; // per month, Rs; null = custom
  minutes: number | null;
  calls: number | null; // at 2.5 minutes per call
  perMinute: string;
  extraMinute: string | null;
  concurrent: number | null;
  logs: string | null;
  support: string;
  highlight?: boolean;
};

export const PLANS: Plan[] = [
  { name: "Start", price: 5499, minutes: 1100, calls: 440, perMinute: "Rs 5.0 per minute", extraMinute: "Rs 5.5", concurrent: 2, logs: "30 days", support: "Email support" },
  { name: "Growth", price: 8999, minutes: 2000, calls: 800, perMinute: "Rs 4.5 per minute", extraMinute: "Rs 5", concurrent: 5, logs: "90 days", support: "Email plus priority chat", highlight: true },
  { name: "Scale", price: 21999, minutes: 5500, calls: 2200, perMinute: "Rs 4.0 per minute", extraMinute: "Rs 4.5", concurrent: 10, logs: "1 year", support: "Priority support plus an onboarding call" },
  { name: "Enterprise", price: null, minutes: null, calls: null, perMinute: "From Rs 3.75 per minute", extraMinute: null, concurrent: null, logs: null, support: "Dedicated account manager" },
];

export const PLAN_NAMES = PLANS.map((p) => p.name);

export const PRICING_FOOTNOTE =
  "*Call counts assume an average call of 2.5 minutes. Prices exclude GST, charged where applicable. Unused minutes do not roll over. Phone number and telephony provider are arranged separately. Rates may change with 30 days' notice.";
