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
    expect(html).not.toContain('class="k-card k-tel"'); // no demo-number card (the footer has its own contact numbers)
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
  test("the first line above the headline is not limited to India", () => {
    const html = render("/");
    const hero = html.slice(html.indexOf('data-section="hero"'), html.indexOf("</h1>"));
    expect(hero).toContain(">Voice agents for businesses<");
    expect(html).not.toMatch(/Indian businesses/);
  });
  test("plans section: heading, buttons, value strip, extras and billing FAQ, with no prices", () => {
    const html = render("/");
    const sec = html.slice(html.indexOf('id="pricing"'), html.indexOf('data-section="faq"'));
    const text = sec.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Plans built around your call volume.");
    for (const p of ["Start", "Growth", "Scale", "Enterprise"]) expect(sec).toContain(`href="/book-a-call?plan=${p}"`);
    expect((sec.match(/>Book a call</g) || []).length).toBe(3);
    expect(sec).toMatch(/>Talk to us</);
    for (const t of ["1,100 minutes /month", "2,000 minutes /month", "5,500 minutes /month", "About 440 calls*", "Custom minutes",
      "Custom", "Most chosen", "Pricing is shared on a 15-minute call. No lock-in, cancel any month.",
      "Set up for you, ready to take calls", "Included in every plan", "Not included, so there are no surprises",
      "Unused minutes do not roll over to the next month.", "How billing works", "Calls at the same time", "Extra minutes",
      "Added automatically", "*Call counts assume an average call of 2.5 minutes."]) expect(text).toContain(t);
    expect(text).not.toContain("Rate per minute");
    expect(text).not.toMatch(/(\bRs\.?|₹)\s*\d|per minute|\d,\d{3}\s*(a|per)/i);
    expect((sec.match(/aria-expanded="false"/g) || []).length).toBe(5); // billing FAQ, all closed
    expect(sec).toMatch(/<ul[^>]*class="k-specs/);
    // Switches are off: no go-live item and no guarantee panel in the page.
    expect(sec).not.toContain("k-guarantee");
    expect((sec.match(/<li[^>]*><h4>/g) || []).length).toBe(3);
  });
  test("no page, title or description carries a price", () => {
    for (const path of ["/", "/features", "/book-a-call"]) {
      const html = render(path);
      const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
      // The missed-call calculator shows the visitor's own numbers in Rs, so it is left out.
      const from = main.indexOf('data-section="calculator"'), to = main.indexOf('data-section="cta"');
      const body = (from < 0 ? main : main.slice(0, from) + main.slice(to)).replace(/<[^>]+>/g, " ");
      expect(body, path).not.toMatch(/(\bRs\.?|₹)\s*\d|per minute/i);
    }
  });
  test("footer shows the email and both phone numbers under the buttons", () => {
    const html = render("/");
    const foot = html.slice(html.indexOf('class="end band"'));
    expect(foot).toContain('href="mailto:hello@kaho.ai"');
    for (const n of ["9343602016", "8295577277"]) expect(foot).toContain(`href="tel:+91${n}"`);
    expect(foot.indexOf("Compare plans")).toBeLessThan(foot.indexOf("9343602016"));
  });
  test("book a call page explains what happens on the call", () => {
    expect(render("/book-a-call")).toContain("On the call we will show you a live demo, recommend the right plan for your call volume and share pricing.");
  });
  test("motion: the page is wrapped for its entrance, the hero card floats among hidden decorations", () => {
    const html = render("/");
    expect(html).toMatch(/<main[^>]*><div class="k-page">/);
    const hero = html.slice(html.indexOf('data-section="hero"'), html.indexOf('data-section="before-after"'));
    expect(hero).toContain('class="k-hero-float"');
    expect((hero.match(/class="k-orb k-orb-[abc]" aria-hidden="true"/g) || []).length).toBe(3);
    expect(hero.replace(/<[^>]+>/g, "")).not.toMatch(/orb/i); // decorations add no text
  });
  test("every footer link target exists on the home page", () => {
    const html = render("/");
    for (const id of ["how", "features", "pricing", "faq"]) expect(html).toContain(`id="${id}"`);
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
