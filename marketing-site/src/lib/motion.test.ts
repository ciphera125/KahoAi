import { describe, expect, test } from "vitest";
import { armFrom, headingKind, startsAtTop, replayAction, revealKind, scrollProgress, staggerDelay, wavePath, WAVE_PERIOD } from "./motion";

const el = (...classes: string[]) => ({
  matches: (selector: string) => selector.split(",").some((s) => classes.includes(s.trim().replace(/^\./, ""))),
});

describe("revealKind", () => {
  test("a plain card still rises", () => {
    expect(revealKind(el("k-card"))).toBe("up");
    expect(revealKind(el("k-card", "k-calc-x"))).toBe("up");
  });
  test("the before card comes from the left, the after card from the right", () => {
    expect(revealKind(el("k-card", "k-ba-card", "k-ba-without"))).toBe("left");
    expect(revealKind(el("k-card", "k-ba-card", "k-ba-with"))).toBe("right");
  });
  test("big panels grow in, wave lines draw", () => {
    expect(revealKind(el("k-panel"))).toBe("zoom");
    expect(revealKind(el("k-pcard"))).toBe("zoom");
    expect(revealKind(el("k-wave", "k-divider"))).toBe("draw");
    expect(revealKind(el("k-wave", "k-steps-wave"))).toBe("draw");
  });
});

describe("revealKind variety", () => {
  const kinds = {
    featureCopy: revealKind(el("k-fblock-copy")),
    agent: revealKind(el("k-card", "k-agent")),
    tile: revealKind(el("k-tile")),
    step: revealKind(el("k-step")),
    faq: revealKind(el("k-faq-item")),
    plan: revealKind(el("k-pcard")),
    included: revealKind(el("k-included")),
    notIncluded: revealKind(el("k-notinc")),
    billingFaq: revealKind(el("k-bfaq")),
    billing: revealKind({ matches: (sel: string) => sel.split(",").some((x) => x.trim() === ".k-bsteps li") }),
    footnote: revealKind(el("k-footnote")),
    cta: revealKind(el("k-cta-in")),
    tel: revealKind(el("k-card", "k-tel")),
  };
  test("text is not all one direction: at most a few pieces slide sideways", () => {
    expect(kinds.featureCopy).toBe("zoom");
    expect(kinds.billingFaq).toBe("blur");
    const sideways = ["left", "right", "wipe"];
    const text = [kinds.featureCopy, kinds.step, kinds.footnote, kinds.faq, kinds.billingFaq, kinds.billing, kinds.cta];
    expect(text.filter((k) => sideways.includes(k)).length).toBe(0);
  });
  test("cards, tiles, steps, FAQ rows and plans each arrive their own way", () => {
    expect(kinds.agent).toBe("flip");
    expect(kinds.tile).toBe("pop");
    expect(kinds.step).toBe("blur");
    expect(kinds.faq).toBe("drop");
    expect(kinds.plan).toBe("zoom");
    expect(kinds.included).toBe("left");
    expect(kinds.notIncluded).toBe("right");
    expect(kinds.footnote).toBe("blur");
    expect(kinds.cta).toBe("pop");
    expect(kinds.tel).toBe("swing");
  });
  test("no single way of arriving is used for more than a third of these", () => {
    const all = Object.values(kinds);
    expect(new Set(all).size).toBeGreaterThanOrEqual(8);
    for (const k of new Set(all)) expect(all.filter((x) => x === k).length).toBeLessThanOrEqual(Math.ceil(all.length / 3));
  });
  test("feature art comes in from the side opposite its text", () => {
    const art = (flipped: boolean) => ({ ...el("k-card", "k-fblock-art"), closest: (s: string) => (flipped && s === ".is-flip" ? {} : null) });
    expect(revealKind(art(false))).toBe("right");
    expect(revealKind(art(true))).toBe("left");
  });
});

describe("staggerDelay", () => {
  test("siblings follow one another, and a long row never waits long", () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(2)).toBe(2 * staggerDelay(1));
    expect(staggerDelay(40)).toBe(staggerDelay(5));
    expect(staggerDelay(-1)).toBe(0);
  });
});

describe("scrollProgress", () => {
  test("0 at the top, 1 at the bottom, clamped", () => {
    expect(scrollProgress(0, 2000)).toBe(0);
    expect(scrollProgress(500, 2000)).toBe(0.25);
    expect(scrollProgress(2000, 2000)).toBe(1);
    expect(scrollProgress(2400, 2000)).toBe(1); // rubber-band overscroll
    expect(scrollProgress(-50, 2000)).toBe(0);
  });
  test("a page too short to scroll is never NaN", () => {
    expect(scrollProgress(0, 0)).toBe(0);
    expect(scrollProgress(10, -5)).toBe(0);
  });
});

describe("wavePath", () => {
  const ys = (d: string) => [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  test("two periods long, so it can slide one period and loop without a jump", () => {
    const pts = ys(wavePath());
    expect(pts[0][0]).toBe(0);
    expect(pts[pts.length - 1][0]).toBe(2 * WAVE_PERIOD);
    const at = (x: number) => pts.find((p) => p[0] === x)?.[1];
    for (const x of [0, 700, 760, 800]) expect(at(x)).toBe(at(x + WAVE_PERIOD));
  });
  test("flat at the seams, a burst in between", () => {
    const pts = ys(wavePath());
    expect(pts[0][1]).toBe(12);
    expect(pts[pts.length - 1][1]).toBe(12);
    expect(Math.max(...pts.map((p) => Math.abs(p[1] - 12)))).toBeGreaterThan(6);
  });
});

describe("armFrom", () => {
  test("an element above the screen waits further up, one below waits further down", () => {
    // Waiting elements are shifted; shifting one back towards the screen would make it
    // count as visible again and flicker for ever at the edge.
    expect(armFrom(-300)).toBe("top");
    expect(armFrom(-1)).toBe("top");
    expect(armFrom(0)).toBe("bottom");
    expect(armFrom(900)).toBe("bottom");
  });
});

describe("replayAction", () => {
  test("shown once enough of it is in view", () => {
    expect(replayAction(true, 0.15, 0.15)).toBe("show");
    expect(replayAction(true, 1, 0.15)).toBe("show");
  });
  test("re-armed only when it has left the screen completely, so it plays again next time", () => {
    expect(replayAction(false, 0, 0.15)).toBe("reset");
  });
  test("a sliver in view changes nothing: never hide something the visitor can still see", () => {
    expect(replayAction(true, 0.05, 0.15)).toBe(null);
    expect(replayAction(true, 0, 0.15)).toBe(null);
  });
});

describe("headingKind", () => {
  const eight = Array.from({ length: 8 }, (_, i) => headingKind(i));
  test("section headings take turns, so neighbours never arrive the same way", () => {
    for (let i = 1; i < eight.length; i++) expect(eight[i]).not.toBe(eight[i - 1]);
    expect(new Set(eight).size).toBeGreaterThanOrEqual(5);
  });
  test("only two of eight go left to right", () => {
    expect(eight.filter((k) => k === "wipe").length).toBe(2);
    expect(eight.some((k) => k === "left" || k === "right")).toBe(false);
  });
  test("it cycles for any position, and bad input is the first kind", () => {
    expect(headingKind(8)).toBe(headingKind(0));
    expect(headingKind(-1)).toBe(headingKind(0));
    expect(headingKind(NaN)).toBe(headingKind(0));
  });
  test("revealKind hands the heading its turn", () => {
    expect(revealKind(el("k-head"), 1)).toBe(headingKind(1));
    expect(revealKind(el("k-split-head"), 2)).toBe(headingKind(2));
  });
});

describe("startsAtTop", () => {
  test("a refresh starts at the top, a link or a fresh visit goes where it points", () => {
    expect(startsAtTop("reload")).toBe(true);
    expect(startsAtTop("navigate")).toBe(false);
    expect(startsAtTop("back_forward")).toBe(false);
    expect(startsAtTop(undefined)).toBe(false);
  });
});
