import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles/fonts.css";
import { AppRoutes } from "./App";
import { startsAtTop } from "./lib/motion";
import "./styles/site.css";

// A refresh opens the first screen: not a #section left in the address bar, nor the browser's memory of where we were.
const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
if (startsAtTop(nav?.type)) {
  history.scrollRestoration = "manual";
  if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
  window.scrollTo(0, 0);
}

const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>
);

// Built pages arrive prerendered (scripts/prerender.mjs); the dev server sends an empty root.
if (root.firstElementChild) hydrateRoot(root, app);
else createRoot(root).render(app);
