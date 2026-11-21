// Title, description and canonical for every page. Used by the prerender step
// (scripts/prerender.mjs) and on the client when the route changes.
export type PageMeta = { path: string; title: string; description: string; noindex?: boolean };

export const PAGES: PageMeta[] = [
  {
    path: "/",
    title: "Kaho AI | Voice AI agents for your calls, in Hindi and English",
    description: "Voice AI agents that call your customers, book appointments and follow up, in Hindi and English.",
  },
  {
    path: "/features",
    title: "Features | Kaho AI",
    description: "One voice agent for your reminders, follow-ups and lead calls, in Hindi and English. Books appointments on the call and logs every call in your dashboard.",
  },
  {
    path: "/book-a-call",
    title: "Book a demo call | Kaho AI",
    description: "Book a 15-minute demo call with Kaho AI. No obligation. See a live demo on a real call, get your questions answered and a plan recommended for your call volume.",
  },
  { path: "/privacy", title: "Privacy policy | Kaho AI", description: "The Kaho AI privacy policy is coming soon.", noindex: true },
  { path: "/terms", title: "Terms | Kaho AI", description: "The Kaho AI terms of service are coming soon.", noindex: true },
];

export const NOT_FOUND: PageMeta = { path: "/404", title: "Page not found | Kaho AI", description: "This page does not exist.", noindex: true };

export const metaFor = (path: string) => PAGES.find((p) => p.path === path) || NOT_FOUND;
