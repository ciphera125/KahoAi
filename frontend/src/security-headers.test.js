import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { securityHeaders } from "../security-headers.js";

test("static host headers forbid framing, sniffing, referrers and foreign scripts", () => {
  const h = securityHeaders;
  assert.match(h["Content-Security-Policy"], /default-src 'self'/);
  assert.match(h["Content-Security-Policy"], /script-src 'self'(;|$)/);
  assert.match(h["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(h["Content-Security-Policy"], /object-src 'none'/);
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "no-referrer");
  assert.match(h["Strict-Transport-Security"], /max-age=\d{7,}/);
});

test("public/_headers (for Netlify/Cloudflare-style hosts) carries every header", () => {
  const file = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  for (const [k, v] of Object.entries(securityHeaders)) assert.ok(file.includes(`${k}: ${v}`), k);
});
