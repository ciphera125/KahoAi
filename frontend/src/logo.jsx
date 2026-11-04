// The Kaho AI parrot, drawn from the brand artwork: navy body, white wing line,
// open golden beak and (optionally) the sound waves. --logo-navy flips to a
// light navy in dark mode so the bird stays visible on a dark page.
export function LogoMark({ size = 40, waves = true }) {
  const w = waves ? 532 : 440;
  return (
    <svg viewBox={`174 186 ${w} 428`} width={size * w / 428} height={size} role="img" aria-label="Kaho AI" className="parrot">
      <g fill="var(--logo-navy, #0B1D4A)">
        <path d="M366 224C384 238 404 248 420 247L396 292C380 270 372 248 366 224Z" />
        <path d="M534 196C500 186 462 198 436 222C420 236 400 246 380 244L398 290C414 262 440 244 470 244L534 262Z" />
        <circle cx="500" cy="263" r="62" />
        <path d="M531 334C534 440 482 520 396 535C356 541 322 540 303 540L232 523L180 612C232 606 276 580 303 540L232 523L360 338C380 330 420 330 455 352C500 342 520 342 531 334Z" />
        <path d="M303 540C276 580 232 606 180 612L232 523Z" />
      </g>
      <circle cx="500" cy="262" r="49" fill="var(--logo-face, #fff)" />
      <circle cx="498" cy="250" r="14" fill="var(--logo-navy, #0B1D4A)" />
      <path fill="var(--logo-navy, #0B1D4A)" stroke="var(--logo-face, #fff)" strokeWidth="9" strokeLinejoin="round" d="M372 330C420 330 455 365 455 400C455 455 380 506 245 506L358 340C362 334 366 331 372 330Z" />
      <g fill="#F0A518">
        <path d="M535 198C575 196 604 222 612 245L542 268Z" />
        <path d="M542 276L612 252C610 270 600 285 596 292C580 318 556 325 535 325V198L535 276Z" />
      </g>
      {waves && (
        <g fill="none" stroke="#F0A518" strokeWidth="7" strokeLinecap="round">
          <path d="M634 237C640 247 640 257 634 266" /><path d="M652 222C666 240 666 262 652 280" /><path d="M672 203C692 232 692 268 672 297" />
        </g>
      )}
    </svg>
  );
}

export function Wordmark() {
  return <span className="wordmark">Kaho <em>AI</em></span>;
}
