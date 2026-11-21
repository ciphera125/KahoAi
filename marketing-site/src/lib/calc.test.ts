import { describe, expect, test } from "vitest";
import { missedCalls, toNumber, formatRupees, formatCount, LIMITS } from "./calc";

describe("toNumber", () => {
  test("empty, junk and negative input count as zero", () => {
    expect(toNumber("", 100)).toBe(0);
    expect(toNumber("   ", 100)).toBe(0);
    expect(toNumber("abc", 100)).toBe(0);
    expect(toNumber("-5", 100)).toBe(0);
  });
  test("commas are allowed, as people type 1,500", () => {
    expect(toNumber("1,500", 1e7)).toBe(1500);
  });
  test("huge input is clamped to the maximum", () => {
    expect(toNumber("1e400", 1000)).toBe(1000);
    expect(toNumber("99999999999999999999", 1000)).toBe(1000);
  });
});

describe("missedCalls", () => {
  test("the example values: 40 calls, 30% missed, Rs 1,500 a customer", () => {
    const r = missedCalls({ callsPerDay: "40", missedPct: "30", customerValue: "1500" });
    expect(r.perDay).toBeCloseTo(12);
    expect(r.perMonth).toBeCloseTo(312); // 26 working days
    expect(r.perMinute).toBeCloseTo(0.02); // 10-hour day = 600 minutes
    expect(r.revenuePerMonth).toBeCloseTo(468000);
  });
  test("percentage is clamped to 0..100", () => {
    expect(missedCalls({ callsPerDay: "10", missedPct: "250", customerValue: "1" }).perDay).toBe(10);
    expect(missedCalls({ callsPerDay: "10", missedPct: "-20", customerValue: "1" }).perDay).toBe(0);
  });
  test("zero, empty and negative inputs give zeros, never NaN", () => {
    for (const v of ["", "0", "-1", "x"]) {
      const r = missedCalls({ callsPerDay: v, missedPct: v, customerValue: v });
      for (const n of Object.values(r)) expect(n).toBe(0);
    }
  });
  test("very large inputs stay finite", () => {
    const r = missedCalls({ callsPerDay: "1e308", missedPct: "100", customerValue: "1e308" });
    for (const n of Object.values(r)) expect(Number.isFinite(n)).toBe(true);
    expect(r.perDay).toBe(LIMITS.callsPerDay);
  });
});

describe("formatting", () => {
  test("rupees use Indian grouping", () => {
    expect(formatRupees(468000)).toBe("Rs 4,68,000");
    expect(formatRupees(12345678.4)).toBe("Rs 1,23,45,678");
    expect(formatRupees(0)).toBe("Rs 0");
  });
  test("counts show at most the given decimals", () => {
    expect(formatCount(12, 1)).toBe("12");
    expect(formatCount(13.25, 1)).toBe("13.3");
    expect(formatCount(0.02, 2)).toBe("0.02");
    expect(formatCount(Number.NaN, 2)).toBe("0");
  });
});
