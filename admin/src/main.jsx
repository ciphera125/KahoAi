import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "../../frontend/src/styles.css";
import "./admin.css";
import { ToastProvider } from "../../frontend/src/ui.jsx";
import { AdminProvider } from "./auth.jsx";
import App from "./App.jsx";

// Applied before the first paint, so there is no flash of the wrong theme (the same saved choice as the Studio's).
try {
  const saved = localStorage.getItem("kaho.theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch { /* private window */ }

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AdminProvider>
          <App />
        </AdminProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
