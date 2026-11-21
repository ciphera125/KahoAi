import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { securityHeaders } from "./security-headers.js";

// The admin site is its own app on its own address. It reuses the Studio's components and styles by import
// (../frontend/src), so the two look and behave the same, and must therefore use ONE copy of React, the router
// and the dialog library: `dedupe` makes the Studio's files resolve them from here.
// In dev, /api is proxied to the backend so the browser's Origin stays this site's own, which is the only
// origin the backend lets reach /api/admin (ADMIN_ORIGINS).
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom", "react-router-dom", "motion", "@radix-ui/react-dialog", "@radix-ui/react-tooltip"] },
  server: {
    port: 5174,
    allowedHosts: [".ngrok-free.dev"],
    fs: { allow: [".."] },
    proxy: {
      "/api": { target: process.env.VITE_API_TARGET || "http://127.0.0.1:8020", changeOrigin: false },
      // One public address (the tunnel) serves both the admin site and the phone server: Plivo reaches
      // /answer, /hangup, /transfer and the /ws audio stream here. Each is still guarded by WEBHOOK_SECRET,
      // Plivo's signature and, for /ws, a single-use token. Dev only; a real deploy uses a proper router.
      ...Object.fromEntries(["/answer", "/hangup", "/transfer"].map((p) => [p, { target: process.env.VITE_VOICE_TARGET || "http://127.0.0.1:8765", changeOrigin: false }])),
      "/ws": { target: process.env.VITE_VOICE_TARGET || "http://127.0.0.1:8765", ws: true, changeOrigin: false },
    },
  },
  preview: { port: 4175, headers: securityHeaders },
  build: { outDir: "dist", sourcemap: false },
});
