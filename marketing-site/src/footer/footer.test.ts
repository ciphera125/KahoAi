// The footer is locked. Hashes re-taken on 2026-11-21 after the owner added the email and two phone
// numbers under the buttons. If either changes again, the footer was edited.
import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sha = (p: string) => createHash("sha256").update(readFileSync(new URL(p, import.meta.url))).digest("hex");

test("footer markup is byte-for-byte the original", () => {
  expect(sha("./footer.html")).toBe("724c22c7a11da97d127620d9eb3c457a487e12cc2f1825b2d66fb59febd36260");
});
test("footer styles are byte-for-byte the original extract", () => {
  expect(sha("./footer.css")).toBe("107e91a0beeaab5e61c1a2e4025d17c672fd13b9e2afcabd726611fbe42a341c");
});
