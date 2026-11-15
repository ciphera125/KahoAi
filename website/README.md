# Kaho AI website

The public marketing site for Kaho AI: Home, Features and Book a call, plus
placeholder Privacy and Terms pages. It is separate from the Studio (`../frontend`)
and has no backend of its own.

Built with Vite, React 19, React Router and TypeScript. Every page is prerendered to
static HTML at build time, so search engines and visitors without JavaScript get the
full page; React takes over in the browser.

## Run locally

```sh
cd website
npm install
npm run dev        # http://localhost:4000, live reload
```

To try the production build locally:

```sh
npm run build
npm run preview -- --port 4000   # http://localhost:4000
```

## Checks

```sh
npm test           # unit tests: calculator, form validation, content rules, page structure, footer lock
npm run build      # runs typecheck and lint first, then builds and prerenders
```

## Settings (environment variables)

Copy `.env.example` to `.env.local` and fill in what you have. All are optional and
read at build time. Never commit real values.

| Variable | What it does | When empty |
|---|---|---|
| `VITE_CONTACT_EMAIL` | Where the booking form's email fallback goes | `hello@kaho.ai` |
| `VITE_DEMO_PHONE` | Public demo number, e.g. `+91 80000 00000` | The Talk to Kaho section, the Hear it live button and the demo line in FAQ 6 are hidden |
| `VITE_BOOKING_URL` | Cal.com or Calendly page embedded on /book-a-call (https only) | The booking form is shown instead |
| `VITE_FORM_ENDPOINT` | Receives the booking form as a JSON POST (https only) | Submitting opens the visitor's email app with the details filled in |

## Deploy to Cloudflare Pages

1. In Cloudflare, Workers and Pages, Create, Pages, Connect to Git, and pick this repository.
2. Build settings:
   - Root directory: `website`
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Environment variable `NODE_VERSION` = `22`, plus any of the `VITE_*` settings above.
3. Add the custom domain `kahoai.in` under the project's Custom domains.

Routing: the build writes `index.html`, `features.html`, `book-a-call.html`,
`privacy.html`, `terms.html` and `404.html`. Cloudflare Pages serves `/features` from
`features.html` and any unknown address from `404.html` with a real 404 status, so no
`_redirects` file is needed (a catch-all SPA rule would hide the 404 page from search
engines). `public/_headers` sets basic security headers and long caching for fonts and
built assets.

## Where things are

```
src/content/        all copy, pricing (pricing.ts) and page titles (seo.ts)
src/components/     Header, Button/Section/Title (ui.tsx), the section blocks, Calculator, Icon
src/pages/          Home, Features, BookACall, and the simple pages
src/lib/            calculator maths and booking-form validation
src/footer/         the locked footer (see below)
src/styles/         site.css (new design, --k-* tokens) and fonts.css (self-hosted fonts)
scripts/            prerender.mjs (build step), subset-devanagari.sh
public/             favicon, share image (og.png), fonts, robots.txt, sitemap.xml, _headers
```

## The footer is locked

`src/footer/footer.html` and `src/footer/footer.css` are byte-for-byte copies of the
footer from the first version of the site. `footer.test.ts` checks them by hash and
fails if either changes. The new design adds its own tokens (`--k-*`) and classes
(`k-*`) and never redefines the footer's.

## Fonts

Fonts are self-hosted from `public/fonts` (all SIL Open Font License): Bricolage
Grotesque for headings, Figtree for body text, IBM Plex Mono for labels, EB Garamond
for the one italic word per heading and the footer, and Noto Sans Devanagari for Hindi.
The Devanagari font is cut down to the characters the site uses. After adding new
Hindi text, run `scripts/subset-devanagari.sh` (instructions inside) and rebuild.

## Open items (need input)

- Demo phone number, booking page URL and form endpoint (see Settings).
- A real dashboard screenshot: put it at `public/brand/dashboard.png` and swap the
  mock in `src/pages/Home.tsx` (marked TODO).
- Legal copy for `/privacy` and `/terms`, and the call-recording answer in FAQ 4
  (marked TODO in `src/content/content.ts`).
- Confirm FAQ 5 (what happens when the agent cannot answer) matches the product.
