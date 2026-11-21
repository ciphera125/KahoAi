// The pure parts of the site's motion, kept apart from the DOM so they can be tested.

export type RevealKind = "up" | "left" | "right" | "zoom" | "draw" | "wipe" | "flip" | "pop" | "blur" | "drop" | "swing";

// How an element arrives when it scrolls into view. First match wins; the rest rise.
// Different kinds of thing arrive differently so the page does not repeat itself:
//   draw  a line draws itself          wipe  uncovered left to right (two section headings only)
//   left / right  slides in            flip  a card tips up from its top edge
//   zoom  grows from slightly smaller  pop   springs in with a small overshoot
//   blur  comes into focus             drop  settles down from above
//   swing a card swings in on a tilt   up    plain rise (the fallback)
const KINDS: [string, RevealKind][] = [
  [".k-divider, .k-steps-wave", "draw"],
  [".k-ba-without, .k-included", "left"],
  [".k-ba-with, .k-notinc", "right"],
  [".k-panel, .k-pcard, .k-calc", "zoom"],
  [".k-fblock-copy", "zoom"],
  [".k-agent", "flip"],
  [".k-tile, .k-cta-in", "pop"],
  [".k-step, .k-footnote, .k-bsteps li, .k-split-head, .k-bfaq", "blur"],
  [".k-faq-item", "drop"],
  [".k-tel", "swing"],
];

type Revealable = { matches(selector: string): boolean; closest?(selector: string): unknown };

// Section headings take turns, in page order. Only two of eight are wiped left to right.
const HEADING_KINDS: RevealKind[] = ["wipe", "drop", "blur", "pop", "zoom", "swing", "wipe", "blur"];

export function headingKind(index: number): RevealKind {
  const n = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  return HEADING_KINDS[n % HEADING_KINDS.length];
}

/** True when the page was reloaded: it opens at the top, not where the address bar's #section or the browser's memory points. */
export function startsAtTop(navigationType: string | undefined): boolean {
  return navigationType === "reload";
}

/** `nth` is the element's place among the section headings on the page. */
export function revealKind(el: Revealable, nth = 0): RevealKind {
  if (el.matches(".k-head, .k-split-head")) return headingKind(nth);
  // Feature art comes in from the side opposite its text.
  if (el.matches(".k-fblock-art")) return el.closest?.(".is-flip") ? "left" : "right";
  for (const [selector, kind] of KINDS) if (el.matches(selector)) return kind;
  return "up";
}

/**
 * What to do with a play-on-arrival element when its visibility changes. It is shown
 * once `threshold` of it is in view, and re-armed (hidden again, to replay next time)
 * only when none of it is, so nothing the visitor can still see ever disappears.
 */
export function replayAction(isIntersecting: boolean, ratio: number, threshold: number): "show" | "reset" | null {
  if (!isIntersecting) return "reset";
  return ratio >= threshold && ratio > 0 ? "show" : null;
}

/**
 * Which side an off-screen element waits on, from the top of its box relative to the
 * viewport. A waiting element is shifted away from the screen, never towards it:
 * shifted towards it, it would count as visible, arrive, leave and loop at the edge.
 */
export function armFrom(top: number): "top" | "bottom" {
  return top < 0 ? "top" : "bottom";
}

/** Milliseconds the i-th sibling waits, so a row arrives one after another. */
export function staggerDelay(index: number): number {
  return Math.min(Math.max(index, 0), 5) * 90;
}

/** How far down the page we are, 0 to 1. `max` is the scrollable distance. */
export function scrollProgress(scrollY: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.min(Math.max(scrollY / max, 0), 1);
}

// The signature motif: a thin line that breaks into a short burst of sound.
// The path is two periods long, so sliding it left by one period loops with no jump.
export const WAVE_PERIOD = 1200;
const BURST_AT = 760; // a little right of the middle

export function wavePath(): string {
  const pts: string[] = [];
  for (let x = 0; x <= 2 * WAVE_PERIOD; x += 4) {
    const xm = x % WAVE_PERIOD;
    const d = (xm - BURST_AT) / 120;
    if (Math.abs(d) > 2.2 && xm !== 0) continue; // the flat stretches need no points
    const y = 12 + Math.sin((xm - BURST_AT) / 5.5) * 9 * Math.exp(-d * d);
    pts.push(`${x},${y.toFixed(2)}`);
  }
  return "M" + pts.join(" L");
}
