import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ConfigContext, type SiteConfig } from "../config";

const base: SiteConfig = { demoPhone: "", bookingUrl: "", formEndpoint: "", contactEmail: "hello@kaho.ai" };

function render(url: string, cfg: Partial<SiteConfig> = {}) {
  return renderToStaticMarkup(
    <ConfigContext.Provider value={{ ...base, ...cfg }}>
      <StaticRouter location={url}><AppRoutes /></StaticRouter>
    </ConfigContext.Provider>,
  );
}
const sections = (html: string) => [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
const h1s = (html: string) => (html.match(/<h1[\s>]/g) || []).length;

describe("home", () => {
  test("sections are in the agreed order, with the demo number", () => {
    const html = render("/", { demoPhone: "+91 80000 00000" });
    expect(sections(html)).toEqual(["hero", "talk", "before-after", "agents", "how", "features", "dashboard", "pricing", "faq", "calculator", "cta"]);
  });
  test("without a demo number: no Talk section, no Hear it live, no demo line in FAQ 6", () => {
    const html = render("/");
    expect(sections(html)).toEqual(["hero", "before-after", "agents", "how", "features", "dashboard", "pricing", "faq", "calculator", "cta"]);
    expect(html).not.toContain("Hear it live");
    expect(html).not.toContain("tel:");
    expect(html).toContain("Book a call and we will show you a live demo.");
    expect(html).not.toContain("Call our demo number");
  });
  test("with a demo number: tel link, Hear it live and the demo line", () => {
    const html = render("/", { demoPhone: "+91 80000 00000" });
    expect(html).toContain('href="tel:+918000000000"');
    expect(html).toContain("Hear it live");
    expect(html).toContain("Call our demo number, or book a call and we will show you a live demo.");
  });
  test("one h1, the agreed headline", () => {
    const html = render("/");
    expect(h1s(html)).toBe(1);
    expect(html.replace(/<[^>]+>/g, "")).toMatch(/Your follow-up calls, made/);
    expect(html.replace(/<[^>]+>/g, "")).not.toMatch(/Incoming call|Never miss/);
  });
  test("pricing cards link to the booking page with their plan", () => {
    const html = render("/");
    for (const p of ["Start", "Growth", "Scale", "Enterprise"]) expect(html).toContain(`href="/book-a-call?plan=${p}"`);
    expect(html).toContain("Most chosen");
    expect(html.replace(/<[^>]+>/g, "")).toContain("1,100 minutes a month");
    const plans = html.slice(html.indexOf('data-section="pricing"'), html.indexOf('data-section="faq"'));
    expect(plans).not.toMatch(/Rs [0-9]|\/month|per minute/); // no prices: they book a call for pricing
  });
  test("the footer comes right after the marigold CTA band", () => {
    const html = render("/");
    const cta = html.lastIndexOf('data-section="cta"');
    const foot = html.indexOf('class="end band"');
    expect(cta).toBeGreaterThan(0);
    expect(foot).toBeGreaterThan(cta);
    expect(html.slice(cta + 1, foot)).not.toContain("data-section=");
  });
});

describe("header", () => {
  test("Home, Features and a Book a call button; no old toggle", () => {
    const html = render("/features");
    expect(html).toMatch(/<header[^>]*class="k-header/);
    expect(html).toContain('href="/features"');
    for (const h of ["/#how", "/#pricing", "/#faq"]) expect(html).toContain(`href="${h}"`);
    expect(html).toMatch(/>Pricing</);
    expect(html).toContain(">Book a call<");
    expect(html).not.toMatch(/For developers|For teams|nav-box|class="seg"/);
  });
});

describe("features page", () => {
  test("eight blocks in order, then the CTA band and footer", () => {
    const html = render("/features");
    const titles = [...html.matchAll(/<h2 class="k-fblock-title"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(titles).toEqual([
      "Calls your customers for you", "Works through your whole list", "Books appointments on the call", "Hindi and English in the same call",
      "Talks like a person", "Your dashboard", "Calls from your own number", "Set up around your business",
    ]);
    expect(html).toContain("Ready to hear it call your customers?");
    expect(h1s(html)).toBe(1);
    expect(html).toContain('class="end band"');
  });
});

describe("book a call page", () => {
  test("form when no booking URL is set", () => {
    const html = render("/book-a-call");
    expect(h1s(html)).toBe(1);
    expect(html.replace(/<[^>]+>/g, "")).toContain("Book a 15-minute demo call");
    for (const f of ["name", "business", "phone", "email", "businessType", "plan", "message"]) expect(html).toContain(`name="${f}"`);
    expect(html).not.toContain("<iframe");
  });
  test("embeds the booking page when an https URL is set", () => {
    const html = render("/book-a-call", { bookingUrl: "https://cal.com/kaho/demo" });
    expect(html).toContain("<iframe");
    expect(html).toContain('loading="lazy"');
  });
  test("ignores a booking URL that is not https", () => {
    const html = render("/book-a-call", { bookingUrl: "javascript:alert(1)" });
    expect(html).not.toContain("<iframe");
  });
});

describe("legal placeholders", () => {
  test("privacy and terms say coming soon", () => {
    expect(render("/privacy")).toContain("Coming soon");
    expect(render("/terms")).toContain("Coming soon");
  });
});
