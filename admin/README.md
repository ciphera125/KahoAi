# Kaho AI Admin

The separate site where Kaho staff run the platform: every organization, its plan and per-minute rates, minutes, top-ups,
people and call rules, with a record of everything an admin does. It is its own app on its own address (`:5174`), with its
own sign-in. It reuses the Studio's components and stylesheet by import (`../frontend/src`), so the two look and behave the
same; `vite.config.js` makes them share one copy of React.

## Run

```bash
npm install
npm run dev        # http://localhost:5174, proxies /api to the backend (:8020)
npm run build      # static files into dist/ (serve with the headers in public/_headers)
npm run lint
npm test           # node --test: the rupees-to-paise form maths
```

## Who can sign in

Only the e-mail addresses in the backend's `ADMIN_EMAILS` (exact match). Creating an account also needs the backend's
`ADMIN_SIGNUP_CODE`; until that is set nobody can. Set both in `backend/.env`, restart the backend, open the site, and
choose "Create account". Everything else about security (origin and host checks, cookie scope, lockout, rate limits,
the append-only record) lives in the backend: see `CLAUDE.md`, "Plans, minutes and the admin site".

`VITE_API_TARGET` overrides where `/api` is proxied in dev (default `http://127.0.0.1:8020`).
