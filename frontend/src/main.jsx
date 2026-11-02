import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles.css";
import { AuthProvider } from "./auth.jsx";
import { ToastProvider } from "./ui.jsx";
import App from "./App.jsx";

// Applied before the first paint, so there is no flash of the wrong theme.
try {
  const saved = localStorage.getItem("kaho.theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch { /* private window */ }

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
