// The missed-call calculator. Everything is computed from the visitor's own numbers.

export const WORKING_DAYS_PER_MONTH = 26;
export const BUSINESS_MINUTES_PER_DAY = 600; // a 10-hour day

export const LIMITS = { callsPerDay: 100_000, missedPct: 100, customerValue: 10_000_000 };

export type CalcInput = { callsPerDay: string; missedPct: string; customerValue: string };
export type CalcResult = { perDay: number; perMonth: number; perMinute: number; revenuePerMonth: number };

/** Parse what someone typed. Empty, junk or negative becomes 0; anything above max becomes max. */
export function toNumber(raw: string, max: number): number {
  const n = Number(String(raw).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return n === Infinity ? max : 0;
  return Math.min(n, max);
}

export function missedCalls(input: CalcInput): CalcResult {
  const calls = toNumber(input.callsPerDay, LIMITS.callsPerDay);
  const pct = toNumber(input.missedPct, LIMITS.missedPct);
  const value = toNumber(input.customerValue, LIMITS.customerValue);
  const perDay = (calls * pct) / 100;
  const perMonth = perDay * WORKING_DAYS_PER_MONTH;
  return {
    perDay,
    perMonth,
    perMinute: perDay / BUSINESS_MINUTES_PER_DAY,
    revenuePerMonth: perMonth * value,
  };
}

const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function formatRupees(n: number): string {
  return "Rs " + Math.round(safe(n)).toLocaleString("en-IN");
}

export function formatCount(n: number, decimals: number): string {
  return safe(n).toLocaleString("en-IN", { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}
