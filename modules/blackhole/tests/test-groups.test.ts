import { expect, it } from "vitest";
import { createTestOptions } from "../vitest.config.ts";

it("keeps native host files out of unit without dropping them from integration", () => {
  const unit = createTestOptions("unit");
  const integration = createTestOptions("integration");
  const all = createTestOptions("all");
  expect(unit.include).toEqual(["tests/**/*.test.ts", "src/**/*.test.ts"]);
  expect(unit.exclude).toContain("tests/integration/**");
  expect(unit.testTimeout).toBe(10000);
  expect(integration.include).toEqual(["tests/integration/**/*.test.ts"]);
  expect(integration.maxWorkers).toBe(1);
  expect(integration.fileParallelism).toBe(false);
  expect(all.include).toEqual(unit.include);
  expect(all.exclude).not.toContain("tests/integration/**");
});

it("rejects an unknown suite rather than silently selecting tests", () => {
  expect(() => createTestOptions("typo")).toThrow(/Unknown Blackhole test suite/);
});
