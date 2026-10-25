# Kaho AI Studio — frontend

The Studio as a React single-page app, with a real URL per screen
(`/dashboard`, `/calls`, `/contacts`, `/agents`, `/agents/:id`, `/prompts`,
`/numbers`, `/team`) instead of `#hash` routes. Talks to the backend over `/api`.

## Run

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api to the backend (:8020)
npm run build      # static files into dist/
npm run preview    # serve the built app
npm run lint
```

`VITE_API_TARGET` overrides where `/api` is proxied in dev (default
`http://127.0.0.1:8020`).

## Serving in production (important)

Because the app uses real paths, the host must serve `index.html` for any
unknown path — otherwise a refresh on `/calls` 404s. This **SPA fallback** is
built into the dev server and `npm run preview`; on a static host (Nginx, S3 +
CloudFront, Netlify, …) configure "rewrite all to /index.html". Serve `/api`
from the backend on the same origin (a reverse proxy), so the session cookie and
the backend's same-origin checks work and no CORS is needed.

## Structure

```
src/
  main.jsx           mounts the app with the router, auth and toast providers
  App.jsx            the routes (one screen per real URL)
  api.js             one fetch wrapper (cookies, errors, sign-out on 401)
  auth.jsx           who is signed in (mirrors /api/me; the server enforces access)
  ui.jsx             shared pieces: icons, toast, modal, confirm, menu, formatters
  styles.css         the design tokens, carried over from the original Studio
  components/Layout  sidebar (real links), notifications, profile
  pages/             one file per screen
```
