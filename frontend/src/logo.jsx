// The KahoAI mark: a small voice waveform, not a bare letter. Sits inside the
// existing .mark div (gradient background, rounded square), in the rail and
// the mobile topbar.
export function LogoMark({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <g fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <line x1="4" y1="12" x2="4" y2="12.01" />
        <line x1="8.5" y1="7" x2="8.5" y2="17" />
        <line x1="13" y1="4" x2="13" y2="20" />
        <line x1="17.5" y1="8" x2="17.5" y2="16" />
        <line x1="21" y1="11" x2="21" y2="13" />
      </g>
    </svg>
  );
}
