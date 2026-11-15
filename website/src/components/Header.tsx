import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { Button } from "./ui";
import { Icon } from "./Icon";

// The parrot mark the site already used, unchanged.
export function Logo() {
  return (
    <svg viewBox="174 186 532 428" width="38" height="30" aria-hidden="true" focusable="false">
      <g fill="#1A1A1A"><path d="M366 224C384 238 404 248 420 247L396 292C380 270 372 248 366 224Z"/><path d="M534 196C500 186 462 198 436 222C420 236 400 246 380 244L398 290C414 262 440 244 470 244L534 262Z"/><circle cx="500" cy="263" r="62"/><path d="M531 334C534 440 482 520 396 535C356 541 322 540 303 540L232 523L180 612C232 606 276 580 303 540L232 523L360 338C380 330 420 330 455 352C500 342 520 342 531 334Z"/><path d="M303 540C276 580 232 606 180 612L232 523Z"/></g>
      <circle cx="500" cy="262" r="49" fill="#FFFFEB"/><circle cx="498" cy="250" r="14" fill="#1A1A1A"/>
      <path fill="#1A1A1A" stroke="#FFFFEB" strokeWidth="9" strokeLinejoin="round" d="M372 330C420 330 455 365 455 400C455 455 380 506 245 506L358 340C362 334 366 331 372 330Z"/>
      <g fill="#1A1A1A"><path d="M535 198C575 196 604 222 612 245L542 268Z"/><path d="M542 276L612 252C610 270 600 285 596 292C580 318 556 325 535 325V198L535 276Z"/></g>
    </svg>
  );
}

const LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/features", label: "Features", end: false },
];

export function Header() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  // Close the menu on Escape; links close it when followed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="k-header">
      <div className="k-header-in">
        <Link to="/" className="k-brand" aria-label="Kaho AI home" onClick={close}>
          <Logo />
          <span>Kaho AI</span>
        </Link>
        <nav className="k-nav" aria-label="Main">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `k-nav-link${isActive ? " is-active" : ""}`}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <Button to="/book-a-call" className="k-header-cta" onClick={close}>Book a call</Button>
        <button type="button" className="k-burger" aria-expanded={open} aria-controls="k-mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? "close" : "menu"} />
        </button>
      </div>
      <nav id="k-mobile-nav" className="k-mobile-nav" aria-label="Main, mobile" hidden={!open}>
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} onClick={close} className={({ isActive }) => `k-mobile-link${isActive ? " is-active" : ""}`}>
            {l.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
