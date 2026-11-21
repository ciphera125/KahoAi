import type { MouseEvent, ReactNode } from "react";
import { useConfig, telHref } from "../config";
import * as c from "../content/content";
import { PricingSection } from "../components/pricing";
import { Button, Eyebrow, Section, Title, WaveRule, type Tone } from "../components/ui";
import { AgentCard, BeforeAfter, CallCard, CtaBand, DashboardMock, Faq, FeatureTile, StepList, TextLink } from "../components/blocks";
import { Calculator } from "../components/Calculator";
import { Icon } from "../components/Icon";
import { track } from "../lib/track";

type Block = { key: string; render: (tone: Tone) => ReactNode };

// Scrolls to the call section without putting #talk in the address bar, so a refresh opens the top.
function scrollToTalk(e: MouseEvent<HTMLElement>) {
  const el = document.getElementById("talk");
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

export function Home() {
  const { demoPhone } = useConfig();
  const hasDemo = Boolean(demoPhone);

  const blocks: Block[] = [
    {
      key: "hero",
      render: (tone) => (
        <Section name="hero" tone={tone} className="k-hero" labelledBy="k-h1">
          <span className="k-deva-mark k-hero-mark" aria-hidden="true" lang="hi" data-mark="कहो" />
          <div className="k-hero-grid">
            <div className="k-hero-copy">
              <Eyebrow>{c.hero.eyebrow}</Eyebrow>
              <Title as="h1" id="k-h1" parts={c.hero.title} />
              <p className="k-lede">{c.hero.sub}</p>
              <div className="k-actions">
                <Button to="/book-a-call" arrow onClick={() => track("book_call_clicked", { plan: "none", source: "hero" })}>Book a call</Button>
                {hasDemo && <Button href="#talk" variant="outline" onClick={scrollToTalk}>Hear it live</Button>}
              </div>
            </div>
            <div className="k-hero-art">
              <span className="k-orb k-orb-a" aria-hidden="true" />
              <span className="k-orb k-orb-b" aria-hidden="true" />
              <span className="k-orb k-orb-c" aria-hidden="true" />
              <div className="k-hero-float"><CallCard {...c.hero.example} /></div>
            </div>
          </div>
        </Section>
      ),
    },
    ...(hasDemo ? [{
      key: "talk",
      render: (tone: Tone) => (
        <Section id="talk" name="talk" tone={tone} className="k-talk" labelledBy="k-talk-t">
          <div className="k-split">
            <div className="k-split-head">
              <Eyebrow>{c.talk.eyebrow}</Eyebrow>
              <h2 id="k-talk-t" className="k-title">{c.talk.title}</h2>
              <p className="k-lede">{c.talk.line}</p>
            </div>
            <a className="k-card k-tel" href={telHref(demoPhone)}>
              <span className="k-tel-icon"><Icon name="phone" size={28} /></span>
              <span className="k-tel-num">{demoPhone}</span>
              <span className="k-tel-hint">Tap to call</span>
            </a>
          </div>
        </Section>
      ),
    }] : []),
    {
      key: "before-after",
      render: (tone) => (
        <Section name="before-after" tone={tone} labelledBy="k-ba-t">
          <div className="k-head"><Eyebrow>{c.beforeAfter.eyebrow}</Eyebrow><Title id="k-ba-t" parts={c.beforeAfter.title} /></div>
          <BeforeAfter without={c.beforeAfter.without} with={c.beforeAfter.with} />
        </Section>
      ),
    },
    {
      key: "agents",
      render: (tone) => (
        <Section name="agents" tone={tone} labelledBy="k-ag-t">
          <div className="k-head"><Eyebrow>{c.agents.eyebrow}</Eyebrow><Title id="k-ag-t" parts={c.agents.title} /></div>
          <div className="k-agents">{c.agents.items.map((a) => <AgentCard key={a.title} {...a} tag={c.agents.tag} />)}</div>
        </Section>
      ),
    },
    {
      key: "how",
      render: (tone) => (
        <Section id="how" name="how" tone={tone} labelledBy="k-how-t">
          <div className="k-head"><Eyebrow>{c.how.eyebrow}</Eyebrow><Title id="k-how-t" parts={c.how.title} /></div>
          <StepList steps={c.how.steps} />
        </Section>
      ),
    },
    {
      key: "features",
      render: (tone) => (
        <Section id="features" name="features" tone={tone} labelledBy="k-wyg-t">
          <div className="k-split k-split-top">
            <div className="k-split-head">
              <Eyebrow>{c.whatYouGet.eyebrow}</Eyebrow>
              <Title id="k-wyg-t" parts={c.whatYouGet.title} />
              <TextLink to="/features">{c.whatYouGet.link}</TextLink>
            </div>
            <ul className="k-tiles">{c.whatYouGet.tiles.map((t) => <FeatureTile key={t.title} {...t} />)}</ul>
          </div>
        </Section>
      ),
    },
    {
      key: "dashboard",
      render: (tone) => (
        <Section name="dashboard" tone={tone} labelledBy="k-dash-t">
          <div className="k-panel">
            <div className="k-panel-head">
              <Eyebrow>{c.dashboard.eyebrow}</Eyebrow>
              <Title id="k-dash-t" parts={c.dashboard.title} />
              <p className="k-lede">{c.dashboard.line}</p>
            </div>
            {/* TODO: replace with a real screenshot at public/brand/dashboard.png in a browser frame. */}
            <DashboardMock nav={c.dashboard.nav} rows={c.dashboard.rows} label={c.dashboard.sampleLabel} />
          </div>
        </Section>
      ),
    },
    { key: "pricing", render: (tone) => <PricingSection tone={tone} /> },
    {
      key: "faq",
      render: (tone) => (
        <Section id="faq" name="faq" tone={tone} labelledBy="k-faq-t">
          <div className="k-split k-split-top">
            <div className="k-split-head"><Eyebrow>{c.faq.eyebrow}</Eyebrow><Title id="k-faq-t" parts={c.faq.title} /></div>
            <Faq items={c.faqItems(hasDemo)} />
          </div>
        </Section>
      ),
    },
    {
      key: "calculator",
      render: (tone) => (
        <Section name="calculator" tone={tone} labelledBy="k-calc-t">
          <div className="k-head k-head-wide">
            <div><Eyebrow>{c.calculator.eyebrow}</Eyebrow><Title id="k-calc-t" parts={c.calculator.title} /></div>
            <p className="k-lede">{c.calculator.intro}</p>
          </div>
          <Calculator />
        </Section>
      ),
    },
  ];

  return (
    <>
      {blocks.map((b, i) => (
        <div key={b.key} className="k-block">
          {i > 0 && <WaveRule className="k-divider" />}
          {b.render(i % 2 === 0 ? "paper" : "sage")}
        </div>
      ))}
      <CtaBand title={c.homeCta.title} />
    </>
  );
}
