import assert from "node:assert/strict";
import { test } from "node:test";
import { KEYTERM_LIMIT, keytermsText, parseKeyterms } from "./keyterms.js";

test("one word or name per line becomes the list", () => {
  assert.deepEqual(parseKeyterms("Dr. Mehta\nApollo Clinic"), ["Dr. Mehta", "Apollo Clinic"]);
});

test("spaces, blank lines, Windows line ends and repeats are tidied away", () => {
  assert.deepEqual(parseKeyterms("  Dr. Mehta  \r\n\r\n   \ndr. mehta\nApollo Clinic\n"), ["Dr. Mehta", "Apollo Clinic"]);
});

test("nothing typed is an empty list", () => {
  assert.deepEqual(parseKeyterms(""), []);
  assert.deepEqual(parseKeyterms(null), []);
  assert.deepEqual(parseKeyterms(undefined), []);
  assert.deepEqual(parseKeyterms("\n \n"), []);
});

test("a comma is left for the server to refuse, never quietly split", () => {
  // Splitting "one, two" here would change what the person typed without telling them.
  assert.deepEqual(parseKeyterms("one, two"), ["one, two"]);
});

test("the saved list goes back into the box one to a line", () => {
  assert.equal(keytermsText(["Dr. Mehta", "Apollo Clinic"]), "Dr. Mehta\nApollo Clinic");
  assert.equal(keytermsText([]), "");
  assert.equal(keytermsText(undefined), "");
});

test("what is shown and parsed again is the same list", () => {
  const saved = ["डॉक्टर मेहता", "Apollo Clinic"];
  assert.deepEqual(parseKeyterms(keytermsText(saved)), saved);
});

test("the limit matches the server's", () => {
  assert.equal(KEYTERM_LIMIT, 50);
});
