import test from "node:test";
import assert from "node:assert/strict";
import { lockCopy, logsText, minutesText, perMinute, planFacts, rupees, topupQuote } from "./billing.js";

test("rupees writes paise as the rate card does, grouped the Indian way", () => {
  assert.equal(rupees(549900), "₹5,499");
  assert.equal(rupees(2199900), "₹21,999");
  assert.equal(rupees(12345678), "₹1,23,456.78");
  assert.equal(rupees(137500), "₹1,375");
  assert.equal(rupees(0), "₹0");
  assert.equal(rupees(null), "Custom");
});

test("perMinute drops a trailing zero and keeps the paise that matter", () => {
  assert.equal(perMinute(500), "₹5/min");
  assert.equal(perMinute(450), "₹4.5/min");
  assert.equal(perMinute(375), "₹3.75/min");
  assert.equal(perMinute(550), "₹5.5/min");
  assert.equal(perMinute(null), "Custom");
});

test("minutesText groups thousands and says minutes", () => {
  assert.equal(minutesText(1100), "1,100 min");
  assert.equal(minutesText(0), "0 min");
  assert.equal(minutesText(123456), "1,23,456 min");
  assert.equal(minutesText(-5), "-5 min");
  assert.equal(minutesText(null), "-");
});

test("logsText says days, then a year", () => {
  assert.equal(logsText(30), "30 days");
  assert.equal(logsText(90), "90 days");
  assert.equal(logsText(365), "1 year");
  assert.equal(logsText(730), "2 years");
  assert.equal(logsText(null), "Custom");
});

test("planFacts lists a plan the way the rate card does, 'Custom' where Kaho sets it", () => {
  const start = { price_paise: 549900, minutes_included: 1100, approx_calls: 440, rate_paise: 500, rate_is_from: false, extra_paise: 550,
    simultaneous: 2, log_days: 30, support: "Email", languages: "Hindi + English" };
  assert.deepEqual(planFacts(start), [
    ["Price per month", "₹5,499"], ["Minutes included", "1,100"], ["About how many calls", "~440 calls"], ["Works out to", "₹5/min"],
    ["Extra minutes", "₹5.5/min"], ["Simultaneous calls", "2"], ["Call logs kept", "30 days"], ["Support", "Email"], ["Languages", "Hindi + English"]]);
  const enterprise = { price_paise: null, minutes_included: null, approx_calls: null, rate_paise: 375, rate_is_from: true, extra_paise: null,
    simultaneous: null, log_days: null, support: "Dedicated manager", languages: "Hindi + English" };
  const rows = Object.fromEntries(planFacts(enterprise));
  assert.equal(rows["Price per month"], "Custom");
  assert.equal(rows["Works out to"], "From ₹3.75/min");
  assert.equal(rows["Simultaneous calls"], "Custom");
});

test("topupQuote prices minutes at the plan's extra-minute rate, and says what is wrong with a bad number", () => {
  assert.deepEqual(topupQuote(250, 550), { ok: true, amount_paise: 137500, text: "₹1,375" });
  assert.equal(topupQuote("100", 500).amount_paise, 50000);
  for (const bad of [0, 49, 20001, 10.5, "abc", "", null, -3]) {
    const q = topupQuote(bad, 550);
    assert.equal(q.ok, false, String(bad));
    assert.match(q.text, /50 to 20,000/);
  }
  assert.equal(topupQuote(100, null).ok, false);
});

test("lockCopy has plain words for each reason a plan is not open", () => {
  for (const reason of ["subscription_required", "subscription_pending", "subscription_expired", "subscription_suspended"]) {
    const c = lockCopy(reason);
    assert.ok(c.title.length > 3 && c.text.length > 10, reason);
  }
  assert.match(lockCopy("subscription_pending").text, /confirm/i);
  assert.equal(lockCopy("nonsense").title, lockCopy("subscription_required").title);
});
