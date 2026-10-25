import { defineConfig } from "vitest/config";

// One real PostgreSQL test database, so files run one after another.
export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./tests/setup-env.js"],
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
