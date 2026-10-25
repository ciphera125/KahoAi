// node --test src/  (npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCallList } from "./csv.js";

test("a file with a header row: name and phone columns found by their names, in any order", () => {
  const r = parseCallList("Phone,City,Full name\n98765 43210,Pune,Asha Rao\n+91 91234 56789,Delhi,Ravi\n");
  assert.deepEqual(r.rows, [{ name: "Asha Rao", number: "98765 43210" }, { name: "Ravi", number: "+91 91234 56789" }]);
  assert.equal(r.header, true);
});

test("a file without a header: the column that looks like numbers is the number", () => {
  const r = parseCallList("9876543210,Asha\n9123456789,Ravi");
  assert.deepEqual(r.rows, [{ name: "Asha", number: "9876543210" }, { name: "Ravi", number: "9123456789" }]);
  assert.equal(r.header, false);
});

test("quoted cells, commas inside quotes, Windows line ends and Excel's BOM", () => {
  const r = parseCallList('﻿Name,Mobile\r\n"Rao, Asha",98765 43210\r\n"He said ""hi""",9123456789\r\n');
  assert.deepEqual(r.rows, [{ name: "Rao, Asha", number: "98765 43210" }, { name: 'He said "hi"', number: "9123456789" }]);
});

test("semicolons and tabs work as separators too", () => {
  assert.deepEqual(parseCallList("name;number\nAsha;9876543210").rows, [{ name: "Asha", number: "9876543210" }]);
  assert.deepEqual(parseCallList("name\tnumber\nAsha\t9876543210").rows, [{ name: "Asha", number: "9876543210" }]);
});

test("blank lines are dropped; a row with no number is kept so the server can say why", () => {
  const r = parseCallList("name,phone\n\nAsha,\n  \nRavi,9123456789\n");
  assert.deepEqual(r.rows, [{ name: "Asha", number: "" }, { name: "Ravi", number: "9123456789" }]);
});

test("a single column of numbers is enough", () => {
  assert.deepEqual(parseCallList("9876543210\n9123456789").rows, [{ name: "", number: "9876543210" }, { name: "", number: "9123456789" }]);
});

test("a file with no number column says so", () => {
  assert.throws(() => parseCallList("name,city\nAsha,Pune"), /phone number column/);
});

test("an empty file says so", () => {
  assert.throws(() => parseCallList(" \n "), /empty/);
});

test("a spreadsheet formula in a cell is read as text, never evaluated", () => {
  assert.deepEqual(parseCallList("name,phone\n=HYPERLINK(\"x\"),9876543210").rows, [{ name: '=HYPERLINK("x")', number: "9876543210" }]);
});
