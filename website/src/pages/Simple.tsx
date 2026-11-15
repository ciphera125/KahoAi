import { Eyebrow, Section, Button } from "../components/ui";

// TODO(legal): privacy policy and terms need reviewed legal copy before launch.
export function ComingSoon({ title }: { title: string }) {
  return (
    <Section name="simple" tone="paper" className="k-simple" labelledBy="k-h1">
      <Eyebrow>{title}</Eyebrow>
      <h1 id="k-h1" className="k-title k-title-xl">Coming soon</h1>
      <p className="k-lede">Our {title.toLowerCase()} is being written. If you have a question in the meantime, book a call and ask us.</p>
      <div className="k-actions"><Button to="/book-a-call">Book a call</Button></div>
    </Section>
  );
}

export function NotFound() {
  return (
    <Section name="simple" tone="paper" className="k-simple" labelledBy="k-h1">
      <Eyebrow>Page not found</Eyebrow>
      <h1 id="k-h1" className="k-title k-title-xl">This page does not exist</h1>
      <p className="k-lede">The link may be old or mistyped.</p>
      <div className="k-actions"><Button to="/">Go to the home page</Button></div>
    </Section>
  );
}
