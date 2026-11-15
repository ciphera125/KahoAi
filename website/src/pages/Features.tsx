import { featuresCta, featuresPage as p } from "../content/content";
import { Eyebrow, Section, Title } from "../components/ui";
import { CtaBand, FeatureBlock } from "../components/blocks";

// Varied block sizes so the page does not read as identical rows.
const SIZES = ["wide", "narrow", "even", "wide", "narrow", "wide", "even", "narrow"] as const;

export function Features() {
  return (
    <>
      <Section name="features-hero" tone="paper" className="k-hero k-hero-sm" labelledBy="k-h1">
        <span className="k-deva-mark k-hero-mark" aria-hidden="true" lang="hi" data-mark="कहो" />
        <div className="k-hero-copy k-hero-copy-wide">
          <Eyebrow>{p.eyebrow}</Eyebrow>
          <Title as="h1" id="k-h1" parts={p.title} />
          <p className="k-lede">{p.sub}</p>
        </div>
      </Section>
      <Section name="features-list" tone="sage" className="k-fblocks">
        {p.blocks.map((b, i) => <FeatureBlock key={b.title} {...b} flip={i % 2 === 1} size={SIZES[i]} />)}
      </Section>
      <CtaBand title={featuresCta.title} />
    </>
  );
}
