// Plivo's V3 webhook signature: HMAC-SHA256 with the auth token over the URL
// (query sorted, values decoded) and, for a POST, the form fields as key+value
// pairs in key order, then "." and a nonce, base64-encoded. A port of the voice
// service's plivo_signature.py; tests/calling.test.js checks it against Python.
import { createHmac } from "node:crypto";

function grouped(entries) {
  const out = {};
  for (const [k, v] of entries) (out[k] ||= []).push(v);
  return out;
}

const sortedPairs = (params, join) => Object.keys(params).sort()
  .flatMap((k) => [...params[k]].sort().map((v) => join(k, v)));

export function baseString(method, url, body) {
  const u = new URL(url);
  const bare = `${u.protocol}//${u.host}${u.pathname}`;
  const query = sortedPairs(grouped(u.searchParams.entries()), (k, v) => `${k}=${v}`).join("&");
  const hasBody = body && Object.keys(body).length > 0;
  if (method.toUpperCase() === "GET" || !hasBody) return query ? `${bare}?${query}` : bare;
  return `${bare}?${query}${query ? "." : ""}${sortedPairs(body, (k, v) => `${k}${v}`).join("")}`;
}

export function sign(method, url, body, nonce, authToken) {
  return createHmac("sha256", authToken).update(`${baseString(method, url, body || {})}.${nonce}`, "utf8").digest("base64");
}
