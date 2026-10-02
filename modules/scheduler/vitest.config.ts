import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 4, // SDK/bundled CLI imports are heavy; keep CI resource use bounded.
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
