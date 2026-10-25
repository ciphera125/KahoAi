import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app uses real paths (/dashboard, /calls, ...), so both the dev server and
// the production host must serve index.html for any unknown path (SPA fallback).
// In dev, /api and the SSE stream are proxied to the backend so the browser's
// Origin stays the dev origin the backend allows.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.VITE_API_TARGET || "http://127.0.0.1:8020", changeOrigin: false },
    },
  },
  preview: { port: 4173 },
  build: { outDir: "dist", sourcemap: true },
});
