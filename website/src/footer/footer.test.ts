// The footer is locked. These hashes were taken from the footer as it was on the first
// landing page, before the redesign. If either changes, the footer was edited.
import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sha = (p: string) => createHash("sha256").update(readFileSync(new URL(p, import.meta.url))).digest("hex");

test("footer markup is byte-for-byte the original", () => {
  expect(sha("./footer.html")).toBe("33a1b02ce39ebb3661a95caffdb68cf5a23ae73fd4fe2382dcb0d55e35b1a049");
});
test("footer styles are byte-for-byte the original extract", () => {
  expect(sha("./footer.css")).toBe("893dd1ee53e85a159bfc08e8c2a8a339e1f0d7ab9edc11e6f67b62e5e4d503ed");
});
