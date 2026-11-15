// Title, description and canonical for every page. Used by the prerender step
// (scripts/prerender.mjs) and on the client when the route changes.
export type PageMeta = { path: string; title: string; description: string; noindex?: boolean };

export const PAGES: PageMeta[] = [
  {
    path: "/",
    title: "Kaho AI | Voice AI agent that answers your calls in Hindi and English",
    description: "Kaho AI answers your calls, books appointments and follows up with your customers, in Hindi and English, all day and night. For clinics, salons and service companies.",
  },
  {
    path: "/features",
    title: "Features | Kaho AI",
    description: "One voice agent for your incoming calls, outgoing calls and follow-ups, in Hindi and English. Books appointments on the call and logs every call in your dashboard.",
  },
  {
    path: "/book-a-call",
    title: "Book a demo call | Kaho AI",
    description: "Book a 15-minute demo call with Kaho AI. No obligation. See a live demo on a real call and get your questions answered.",
  },
  { path: "/privacy", title: "Privacy policy | Kaho AI", description: "The Kaho AI privacy policy is coming soon.", noindex: true },
  { path: "/terms", title: "Terms | Kaho AI", description: "The Kaho AI terms of service are coming soon.", noindex: true },
];

export const NOT_FOUND: PageMeta = { path: "/404", title: "Page not found | Kaho AI", description: "This page does not exist.", noindex: true };

export const metaFor = (path: string) => PAGES.find((p) => p.path === path) || NOT_FOUND;
