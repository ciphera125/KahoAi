import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 4000, strictPort: true },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}"] },
} as Parameters<typeof defineConfig>[0] & { test: unknown });
