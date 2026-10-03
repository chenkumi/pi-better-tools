import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000, // Real SDK/CLI cases share the CPU with 3 other workers; the 5s default flakes under load.
    maxWorkers: 4, // SDK/bundled CLI imports are heavy; keep CI resource use bounded.
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
