import test from "node:test";
import assert from "node:assert/strict";
import { changed, fromInput, TERM_FIELDS, toInput } from "./forms.js";

test("money is typed in rupees and kept in whole paise, never as a float", () => {
  assert.equal(fromInput("money", "4.5"), 450);
  assert.equal(fromInput("money", "5.50"), 550);
  assert.equal(fromInput("money", "5499"), 549900);
  assert.equal(fromInput("money", "3.75"), 375);
  assert.equal(fromInput("money", "0.1"), 10);
  assert.equal(fromInput("money", "0"), 0);
  assert.equal(fromInput("money", "1,23,456.78"), 12345678);
  assert.equal(fromInput("money", " 4.5 "), 450);
  assert.equal(fromInput("money", "19.99"), 1999); // 19.99 * 100 is 1998.9999999999998 as a float
  assert.equal(fromInput("money", "1.15"), 115);
});

test("money with more than two decimals, a sign, a unit or words is refused, not rounded", () => {
  for (const bad of ["3.755", "-1", "1e3", "abc", "4.5/min", "₹5", "", " ", "1.2.3", "5,", ".", "0x10", "NaN", "Infinity"]) {
    assert.throws(() => fromInput("money", bad), /rupees|amount/i, bad);
  }
});

test("whole numbers are whole numbers", () => {
  assert.equal(fromInput("int", "1100"), 1100);
  assert.equal(fromInput("int", "1,100"), 1100);
  assert.equal(fromInput("int", " 5 "), 5);
  for (const bad of ["1.5", "-2", "abc", "", "1e3", "2 calls"]) assert.throws(() => fromInput("int", bad), /whole number/, bad);
});

test("text is trimmed, and empty text is no value", () => {
  assert.equal(fromInput("text", "  Email + priority chat "), "Email + priority chat");
  assert.equal(fromInput("text", "   "), null);
});

test("an empty box means 'leave it as it is' for numbers on a custom plan", () => {
  assert.equal(fromInput("money", "", { empty: true }), null);
  assert.equal(fromInput("int", " ", { empty: true }), null);
});

test("toInput shows what fromInput will read back", () => {
  assert.equal(toInput("money", 450), "4.5");
  assert.equal(toInput("money", 549900), "5499");
  assert.equal(toInput("money", 375), "3.75");
  assert.equal(toInput("money", 550), "5.5");
  assert.equal(toInput("int", 1100), "1100");
  assert.equal(toInput("money", null), "");
  assert.equal(toInput("text", undefined), "");
  for (const paise of [0, 1, 99, 100, 375, 450, 1999, 549900, 2199900]) assert.equal(fromInput("money", toInput("money", paise)), paise);
});

test("changed lists only the terms that differ, in the units the server takes", () => {
  const before = { price_paise: 549900, minutes_included: 1100, extra_paise: 550, support: "Email" };
  const typed = { price_paise: "5499", minutes_included: "1200", extra_paise: "5.25", support: "Email", simultaneous: "" };
  assert.deepEqual(changed(typed, before), { minutes_included: 1200, extra_paise: 525 });
});

test("every term the server takes has a field", () => {
  assert.deepEqual(TERM_FIELDS.map((f) => f[0]).sort(),
    ["approx_calls", "extra_paise", "languages", "log_days", "minutes_included", "price_paise", "rate_paise", "simultaneous", "support"]);
});
