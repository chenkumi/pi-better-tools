import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./tests/unit-isolation.setup.ts"],
    environment: "node",
    testTimeout: 10000,
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
  resolve: {
    alias: [
      // Rewrite only relative TS-source imports. A blanket suffix alias also
      // rewrites absolute file URLs for real/fake host JS modules on Windows.
      {
        find: /^(\.{1,2}\/.*)\.js$/,
        replacement: "$1",
      },
    ],
  },
});
