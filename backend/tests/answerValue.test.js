import { describe, expect, it } from "vitest";
import { parseAnswer, needsConfirming } from "../src/models/answerValue.js";

// A fixed moment to read "next Friday" from: Monday 9 November 2026, 15:30 IST.
const NOW = new Date("2026-11-09T10:00:00Z");
const on = (kind, text, extra = {}) => parseAnswer(kind, text, { now: NOW, ...extra });

describe("dates the caller says out loud", () => {
  it("reads a plain date as a day in India, not in UTC", () => {
    expect(on("date", "15 December 2026")).toMatchObject({ ok: true, value: "2026-12-15" });
    expect(on("date", "15/12/2026")).toMatchObject({ ok: true, value: "2026-12-15" });
    expect(on("date", "2026-12-15")).toMatchObject({ ok: true, value: "2026-12-15" });
  });

  it("counts today, tomorrow and the day after from the day of the call", () => {
    expect(on("date", "today")).toMatchObject({ value: "2026-11-09" });
    expect(on("date", "tomorrow")).toMatchObject({ value: "2026-11-10" });
    expect(on("date", "day after tomorrow")).toMatchObject({ value: "2026-11-11" });
    expect(on("date", "kal")).toMatchObject({ value: "2026-11-10" });
    expect(on("date", "parso")).toMatchObject({ value: "2026-11-11" });
  });

  it("resolves a weekday to the next one that has not gone", () => {
    // Monday the 9th: "Friday" is the 13th, "next Friday" the 20th.
    expect(on("date", "Friday")).toMatchObject({ value: "2026-11-13" });
    expect(on("date", "next Friday")).toMatchObject({ value: "2026-11-20" });
    expect(on("date", "agle shukravar")).toMatchObject({ value: "2026-11-20" });
    // The same weekday as today means a week away, never today.
    expect(on("date", "Monday")).toMatchObject({ value: "2026-11-16" });
  });

  it("reads a bare day of the month as this month, or next if it has passed", () => {
    expect(on("date", "the 15th")).toMatchObject({ value: "2026-11-15" });
    expect(on("date", "5 tarikh")).toMatchObject({ value: "2026-12-05" });
  });

  it("refuses a date it cannot be sure of, and says what to ask", () => {
    const r = on("date", "sometime soon");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/exact date/i);
  });

  it("refuses a date in the past, since it is almost always a mishearing", () => {
    expect(on("date", "1 January 2020")).toMatchObject({ ok: false });
    expect(on("date", "1 January 2020").message).toMatch(/past/i);
  });
});

describe("amounts in rupees", () => {
  it("reads digits, commas, symbols and the word rupees", () => {
    for (const said of ["12500", "12,500", "₹12,500", "Rs 12500", "12500 rupees"]) {
      expect(on("amount", said)).toMatchObject({ ok: true, value: "12500" });
    }
  });

  it("reads lakh and crore, the way people actually say them", () => {
    expect(on("amount", "2 lakh")).toMatchObject({ value: "200000" });
    expect(on("amount", "1.5 lakh")).toMatchObject({ value: "150000" });
    expect(on("amount", "1 crore")).toMatchObject({ value: "10000000" });
    expect(on("amount", "50 hazaar")).toMatchObject({ value: "50000" });
  });

  it("keeps paise when they are said, and refuses nonsense", () => {
    expect(on("amount", "1500.50")).toMatchObject({ value: "1500.5" });
    expect(on("amount", "a lot")).toMatchObject({ ok: false });
    expect(on("amount", "-500")).toMatchObject({ ok: false });
  });
});

describe("the other kinds", () => {
  it("yes and no, in both languages", () => {
    for (const said of ["yes", "haan", "ha ji", "correct", "theek hai"]) expect(on("yes_no", said)).toMatchObject({ value: "yes" });
    for (const said of ["no", "nahi", "nahin"]) expect(on("yes_no", said)).toMatchObject({ value: "no" });
    expect(on("yes_no", "maybe later")).toMatchObject({ ok: false });
  });

  it("a phone number, in the shapes people say them", () => {
    expect(on("phone", "9876543210")).toMatchObject({ value: "+919876543210" });
    expect(on("phone", "+91 98765 43210")).toMatchObject({ value: "+919876543210" });
    expect(on("phone", "12345")).toMatchObject({ ok: false });
  });

  it("a number on its own", () => {
    expect(on("number", "three")).toMatchObject({ ok: false });
    expect(on("number", "3")).toMatchObject({ value: "3" });
  });

  it("a choice, matched whatever the case and spacing", () => {
    const choices = ["UPI", "Bank transfer", "Cash"];
    expect(on("choice", "bank  transfer", { choices })).toMatchObject({ value: "Bank transfer" });
    expect(on("choice", "paytm", { choices })).toMatchObject({ ok: false });
    expect(on("choice", "paytm", { choices }).message).toContain("UPI");
  });

  it("text is kept as it was said, trimmed and capped", () => {
    expect(on("text", "  near the station  ")).toMatchObject({ ok: true, value: "near the station" });
    expect(on("text", "x".repeat(900)).value).toHaveLength(500);
    expect(on("text", "   ")).toMatchObject({ ok: false });
  });

  it("an unknown kind is refused rather than guessed at", () => {
    expect(on("colour", "blue")).toMatchObject({ ok: false });
  });
});

describe("what has to be read back before it is saved", () => {
  it("covers the kinds that are expensive to get wrong", () => {
    expect(["date", "amount", "phone"].every(needsConfirming)).toBe(true);
    expect(["text", "yes_no", "choice", "number"].some(needsConfirming)).toBe(false);
  });
});
