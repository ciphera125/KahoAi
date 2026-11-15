import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles/fonts.css";
import { AppRoutes } from "./App";
import "./styles/site.css";

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
