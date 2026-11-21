// Content rules from the brief: no invented claims, no banned topics, no em dashes,
// and the pricing exactly as agreed.
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLANS, SPEC_LABELS, planSpecs } from "./plans";
import { PRICING } from "./pricingCopy";
import { offer } from "../config/offer.config";

const root = new URL("../", import.meta.url).pathname;
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "footer" ? [] : files(p);
    return /\.(tsx?|css|html)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}
const sources = [...files(root), new URL("../../index.html", import.meta.url).pathname].map((p) => [p, readFileSync(p, "utf8")] as const);

const BANNED = [
  /whatsapp/i, /omnichannel/i, /broadcast/i, /ticketing/i, /flow builder/i, /on-?premise/i, /\bSSO\b/, /audit log/i,
  /SOC ?2/i, /HIPAA/i, /ISO ?27001/i, /FedRAMP/i, /\bAPI\b/, /for developers/i, /\b20\+/, /n8n/i, /zapier/i,
  /summit/i, /Y ?Combinator/i, /testimonial/i, /trusted by/i, /customers love/i, /case stud/i, /award/i, /lorem/i,
  /Hinglish/i, /incoming/i, /inbound/i, /answers (your|every|the) call/i, /customer calls (the|at)/i, /phone rings/i,
  /all day and night/i, /free tier|free plan/i, /\bpercent faster\b/i, /\d+%\s*(more|fewer|less|faster)/i, /#0B1D4A|#F0A518|#14307A/i,
];

describe("copy rules", () => {
  test("no banned topics or invented claims in any source file", () => {
    for (const [p, s] of sources) for (const re of BANNED) expect(re.test(s), `${re} in ${p}`).toBe(false);
  });
  test("no em dash anywhere", () => {
    for (const [p, s] of sources) expect(s.includes("—"), p).toBe(false);
  });
  test("no slide-style section numbers like 07 /", () => {
    for (const [p, s] of sources) expect(/padStart\(2|k-eyebrow-n/.test(s), p).toBe(false);
  });
  test("none of the old design remains", () => {
    for (const [p, s] of sources) expect(/nav-box|class="seg"|For teams|\.pill\b/.test(s), p).toBe(false);
  });
});

describe("pricing", () => {
  test("four plans, Growth highlighted, minutes as agreed", () => {
    expect(PLANS.map((p) => p.name)).toEqual(["Start", "Growth", "Scale", "Enterprise"]);
    expect(PLANS.map((p) => p.minutes)).toEqual([1100, 2000, 5500, null]);
    expect(PLANS.filter((p) => p.highlight).map((p) => p.name)).toEqual(["Growth"]);
    expect(PLANS.map((p) => p.extra)).toEqual(["Added automatically", "Added automatically", "Added automatically", "Set with us"]);
  });
  test("call counts follow 2.5 minutes per call", () => {
    for (const p of PLANS) if (p.minutes) expect(p.calls).toBe(p.minutes / 2.5);
  });
  test("every card lists the same four spec rows in the same order, with no rate row", () => {
    for (const p of PLANS) expect(planSpecs(p).map(([k]) => k)).toEqual([...SPEC_LABELS]);
    expect([...SPEC_LABELS]).toEqual(["Calls at the same time", "Call log history", "Support", "Extra minutes"]);
  });
  test("plan data has no price, rate or extra-minute rate fields", () => {
    for (const p of PLANS) for (const k of ["price", "rate", "extraRate"]) expect(Object.keys(p)).not.toContain(k);
  });
  test("no price, rate or extra-minute rate appears in any pricing words", () => {
    const text = JSON.stringify([PRICING, PLANS]);
    expect(text).not.toMatch(/(Rs\.?|₹)\s*\d/i);
    expect(text).not.toMatch(/per minute/i);
    expect(text.replace(/minutes \/month/g, "")).not.toMatch(/\/\s*month/i);
    expect(text).not.toMatch(/\d{1,3},\d{3}\s*(a|per|\/)/i);
  });
  test("offer switches ship off", () => {
    expect(offer.goLive).toBeNull();
    expect(offer.guarantee).toBeNull();
  });
});
