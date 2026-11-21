// All words in the Pricing section. No prices, rates or extra-minute rates: see plans.ts.
// Kaho makes outbound calls only; the owner chose that wording on 2026-11-17.

export const PRICING = {
  eyebrow: "Plans",
  title: ["Plans built around your", "call volume."] as const,
  sub: "Pick the volume that fits your business. We set it up for you, and share the pricing on a short call.",
  mostChosen: "Most chosen",
  perMonth: "minutes /month",
  custom: "Custom",
  note: "Pricing is shared on a 15-minute call. No lock-in, cancel any month.",
  value: {
    title: "Set up for you, ready to take calls",
    items: [
      { title: "Set up for you", text: "We build your agent around your business, prompts and tone. You never start from a blank builder." },
      { title: "Hindi and English in the same call", text: "If your customer switches language mid-call, the agent keeps up." },
      { title: "See every call", text: "Contacts, call logs and transcripts in one dashboard." },
    ],
  },
  included: {
    title: "Included in every plan",
    items: [
      // Outbound only, to match what Kaho does today (owner decision, 2026-11-17).
      "AI voice agent that calls your customers for you",
      "Hindi and English, including switching in the same call",
      "Appointment booking on the call",
      "Dashboard with contacts, call logs and transcripts",
      "Agent set up around your business, prompts and tone",
      "Invoice with every payment",
    ],
  },
  notIncluded: {
    title: "Not included, so there are no surprises",
    items: [
      "Your phone number and telephony provider are arranged separately. You bring your own, and we connect Kaho to it.",
      "GST is added where it applies.",
      "Unused minutes do not roll over to the next month.",
    ],
  },
  billing: {
    title: "How billing works",
    // TODO(billing): confirm whether usage is rounded per second or per minute.
    // TODO(billing): confirm "calls that do not connect do not use minutes" matches the billing code.
    steps: [
      { title: "You pick a plan", text: "Each plan includes a set number of minutes every month." },
      { title: "Only connected calls use minutes", text: "Calls that do not connect do not use your minutes." },
      { title: "Go over? Extra minutes are added automatically", text: "No plan change needed. We share the extra-minute rate when we talk." },
    ],
  },
  billingFaq: {
    title: "Billing questions",
    items: [
      { q: "How much does it cost?", a: "It depends on your call volume. Book a 15-minute call and we will recommend a plan and share the pricing." },
      { q: "What counts as a connected minute?", a: "Time while a call is connected and the agent is on the line. Calls that do not connect do not use your minutes." },
      { q: "What happens if I use more than my plan?", a: "Extra minutes are added automatically, so you do not have to change plans. We share the extra-minute rate on the call." },
      // TODO(billing): confirm how plan changes mid-cycle work before saying anything about them here.
      { q: "Can I change or cancel my plan?", a: "You can cancel any month. There is no lock-in." },
      { q: "Is GST included?", a: "Pricing shared on the call excludes GST. GST is added where it applies, and you get an invoice with every payment." },
    ],
  },
  footnote: "*Call counts assume an average call of 2.5 minutes.",
};
