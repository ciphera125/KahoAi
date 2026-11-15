// Small shared pieces: Button, Section, Title, Eyebrow, WaveRule.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";

type ButtonProps = {
  to?: string; // internal route
  href?: string; // tel:, mailto:, #hash
  variant?: "primary" | "outline" | "cta";
  arrow?: boolean;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
};

export function Button({ to, href, variant = "primary", arrow, children, className = "", onClick }: ButtonProps) {
  const cls = `k-btn k-btn-${variant} ${className}`.trim();
  const inner = (
    <>
      <span>{children}</span>
      {arrow && <Icon name="arrow" size={18} className="k-btn-ar" />}
    </>
  );
  if (to) return <Link className={cls} to={to} onClick={onClick}>{inner}</Link>;
  return <a className={cls} href={href} onClick={onClick}>{inner}</a>;
}

/** A heading whose last part is the one serif-italic word. */
export function Title({ as: Tag = "h2", parts, className = "", id }: { as?: "h1" | "h2"; parts: readonly [string, string]; className?: string; id?: string }) {
  return (
    <Tag className={`k-title ${Tag === "h1" ? "k-title-xl" : ""} ${className}`.trim()} id={id}>
      {parts[0]} <em className="k-serif">{parts[1]}</em>
    </Tag>
  );
}

export function Eyebrow({ n, children }: { n?: number; children: ReactNode }) {
  return (
    <p className="k-eyebrow">
      {n !== undefined && <span className="k-eyebrow-n">{String(n).padStart(2, "0")} /</span>} {children}
    </p>
  );
}

export type Tone = "paper" | "sage";

export function Section({ id, name, tone, children, className = "", labelledBy }: {
  id?: string; name: string; tone: Tone; children: ReactNode; className?: string; labelledBy?: string;
}) {
  return (
    <section id={id} data-section={name} className={`k-section k-tone-${tone} ${className}`.trim()} aria-labelledby={labelledBy}>
      <div className="k-container">{children}</div>
    </section>
  );
}

// The signature motif: a thin line that breaks into a short burst of sound.
const WAVE = (() => {
  const pts: string[] = [];
  for (let x = 0; x <= 1200; x += 4) {
    const d = (x - 760) / 120; // burst centred a little right of middle
    const env = Math.exp(-d * d);
    const y = 12 + Math.sin(x / 5.5) * 9 * env;
    pts.push(`${x},${y.toFixed(2)}`);
  }
  return "M" + pts.join(" L");
})();

export function WaveRule({ className = "" }: { className?: string }) {
  return (
    <svg className={`k-wave ${className}`.trim()} viewBox="0 0 1200 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d={WAVE} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
