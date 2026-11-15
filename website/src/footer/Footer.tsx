// The locked footer. Its markup (footer.html) and styles (footer.css) are copied
// byte-for-byte from the first landing page and must not be edited; footer.test.ts
// fails if they change. This file only mounts it and replays the original reveal
// behaviour (fade-up of the heading, line and buttons; rise of the giant wordmark).
import { useEffect, useRef } from "react";
import html from "./footer.html?raw";
import "./footer.css";

export function Footer() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>(".rv, [data-inview]"));
    root.querySelectorAll<HTMLElement>(".rv").forEach((el) => {
      const sibs = Array.from(el.parentElement?.querySelectorAll(":scope > .rv") || []);
      el.style.transitionDelay = Math.max(0, sibs.indexOf(el)) * 80 + "ms";
    });
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add("in");
        io.unobserve(e.target);
      });
    }, { threshold: 0.15 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return <div ref={ref} className="k-footer-slot" dangerouslySetInnerHTML={{ __html: html }} />;
}
