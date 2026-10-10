import { configDefaults, defineConfig } from "vitest/config";

export function createTestOptions(suite: string = "all") {
  if (!["unit", "integration", "all"].includes(suite)) {
    throw new Error(`Unknown Blackhole test suite: ${suite}`);
  }
  return {
    globals: true,
    setupFiles: ["./tests/unit-isolation.setup.ts"],
    environment: "node" as const,
    testTimeout: 10000,
    include: suite === "integration" ? ["tests/integration/**/*.test.ts"] : ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...(suite === "unit" ? ["tests/integration/**"] : [])],
    // Real-host probes pay fresh process/TS-loader startup costs. Keep them
    // separate from unit workers; the all-suite manual entry also stays serial.
    maxWorkers: suite === "unit" ? 2 : 1,
    fileParallelism: suite === "unit",
  };
}

export default defineConfig({
  test: createTestOptions(process.env.PI_BLACKHOLE_TEST_SUITE),
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
