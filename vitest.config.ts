import { defineConfig } from "vitest/config";

const runIntegration = process.env.IMMICH_INTEGRATION === "true";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    exclude: runIntegration ? ["node_modules"] : ["node_modules", "tests/integration/**"],
  },
});
