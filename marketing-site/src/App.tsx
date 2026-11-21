import { useEffect } from "react";
import { Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Header } from "./components/Header";
import { Footer } from "./footer/Footer";
import { Home } from "./pages/Home";
import { Features } from "./pages/Features";
import { BookACall } from "./pages/BookACall";
import { ComingSoon, NotFound } from "./pages/Simple";
import { metaFor } from "./content/seo";
import { SITE_URL } from "./config";
import { armFrom, revealKind, scrollProgress, staggerDelay } from "./lib/motion";

function setMeta(selector: string, attr: string, value: string) {
  const el = document.head.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

/** Keep title, description, canonical and Open Graph in step with the route. */
function useRouteMeta() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const m = metaFor(pathname);
    document.title = m.title;
    setMeta('meta[name="description"]', "content", m.description);
    setMeta('meta[property="og:title"]', "content", m.title);
    setMeta('meta[property="og:description"]', "content", m.description);
    setMeta('meta[property="og:url"]', "content", SITE_URL + m.path);
    setMeta('link[rel="canonical"]', "href", SITE_URL + m.path);
  }, [pathname]);
  // New page: start at the top, unless a #section was asked for.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
    else window.scrollTo({ top: 0, behavior: "instant" }); // never a smooth scroll back up from the last page
  }, [pathname, hash]);
}

// Things that arrive when scrolled into view, every time they come back into view.
// Only elements off screen are ever hidden, so nothing visible blinks, and without JS all is shown.
const REVEAL = [".k-head", ".k-split-head", ".k-card", ".k-tile", ".k-step", ".k-faq-item", ".k-panel", ".k-fblock-copy", ".k-cta-in",
  ".k-footnote", ".k-pcard", ".k-value", ".k-pnote", ".k-included", ".k-notinc", ".k-bsteps li", ".k-bfaq", ".k-divider", ".k-steps-wave"]
  .map((s) => ".k-main " + s).join(", ");
// Sections whose looping animations are paused while they are off screen.
const LIVE = ".k-main .k-block, .k-main .k-cta, .k-main .k-fblocks";
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function useReveal() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!("IntersectionObserver" in window) || reducedMotion()) return;
    const timers = new Map<Element, number>();
    const els = Array.from(document.querySelectorAll<HTMLElement>(REVEAL)).filter((el) => !el.closest(".k-hero"));
    let heading = 0;
    els.forEach((el) => { el.dataset.rv = revealKind(el, el.matches(".k-head, .k-split-head") ? heading++ : 0); });
    // Hidden, with no transition, so it happens unseen and the entrance can play again.
    const arm = (el: HTMLElement, top: number) => {
      window.clearTimeout(timers.get(el));
      el.dataset.rvFrom = armFrom(top); // above the screen: it will come down into view
      el.classList.remove("k-rv-go");
      el.style.removeProperty("--k-rv-delay");
      el.classList.add("k-rv-wait");
    };
    els.forEach((el) => {
      const top = el.getBoundingClientRect().top;
      if (top > window.innerHeight) arm(el, top);
    });

    // Arrive: a little inside the viewport, siblings one after another.
    const show = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        const el = e.target as HTMLElement;
        if (!e.isIntersecting || !el.classList.contains("k-rv-wait")) return;
        const sibs = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.classList.contains("k-rv-wait")) : [];
        const delay = staggerDelay(sibs.indexOf(el));
        el.style.setProperty("--k-rv-delay", delay + "ms");
        el.classList.add("k-rv-go");
        el.classList.remove("k-rv-wait");
        // Once it has arrived, hand the element back to its own hover transitions.
        timers.set(el, window.setTimeout(() => {
          el.classList.remove("k-rv-go");
          el.style.removeProperty("--k-rv-delay");
        }, delay + 1800));
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    // Leave: only once it is completely off screen is it armed to play again.
    const hide = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (!e.isIntersecting) arm(e.target as HTMLElement, e.boundingClientRect.top); });
    });
    els.forEach((el) => { show.observe(el); hide.observe(el); });

    // The hero's entrance is CSS keyframes: switch them off while it is off screen
    // (k-rearm) and they start over when it comes back.
    const rearm = new IntersectionObserver((entries) => {
      entries.forEach((e) => e.target.classList.toggle("k-rearm", !e.isIntersecting));
    });
    document.querySelectorAll(".k-main .k-hero").forEach((el) => rearm.observe(el));

    const live = new IntersectionObserver((entries) => {
      entries.forEach((e) => e.target.classList.toggle("k-off", !e.isIntersecting));
    }, { rootMargin: "200px 0px" });
    document.querySelectorAll(LIVE).forEach((el) => live.observe(el));

    return () => {
      [show, hide, rearm, live].forEach((o) => o.disconnect());
      timers.forEach((t) => window.clearTimeout(t));
      els.forEach((el) => el.classList.remove("k-rv-wait", "k-rv-go"));
      document.querySelectorAll(".k-off, .k-rearm").forEach((el) => el.classList.remove("k-off", "k-rearm"));
    };
  }, [pathname]);
}

// Scroll-linked touches: the progress line under the header, the header's shadow
// once the page has moved, and a slow drift on the hero's layers.
function useScrollMotion() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".k-header");
    const still = reducedMotion();
    let frame = 0;
    const apply = () => {
      frame = 0;
      const y = window.scrollY;
      header?.style.setProperty("--k-progress", String(scrollProgress(y, document.documentElement.scrollHeight - window.innerHeight)));
      header?.classList.toggle("is-scrolled", y > 8);
      if (still || y > window.innerHeight * 1.5) return;
      document.querySelector<HTMLElement>(".k-main .k-hero")?.style.setProperty("--k-par", y.toFixed(0) + "px");
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(apply); };
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}

function Layout() {
  useRouteMeta();
  useReveal();
  useScrollMotion();
  const { pathname } = useLocation();
  return (
    <>
      <a className="k-skip" href="#main">Skip to content</a>
      <Header />
      <main id="main" className="k-main">
        {/* Keyed by route, so each page plays its entrance. */}
        <div key={pathname} className="k-page">
          <Outlet />
        </div>
      </main>
      <Footer />
    </>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="features" element={<Features />} />
        <Route path="book-a-call" element={<BookACall />} />
        <Route path="privacy" element={<ComingSoon title="Privacy policy" />} />
        <Route path="terms" element={<ComingSoon title="Terms" />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
