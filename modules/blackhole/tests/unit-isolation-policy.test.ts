import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mayExerciseNormalDefaults, unitTestsDir } from "./fixtures/unit-isolation-policy.js";

const inheritedPassive = process.env.PI_BLACKHOLE_PASSIVE;

describe("isolated unit passive policy", () => {
  it("allows only audited config/SDK-mocked command files", () => {
    expect(mayExerciseNormalDefaults(join(unitTestsDir, "config.test.ts"))).toBe(true);
    expect(mayExerciseNormalDefaults(join(unitTestsDir, "blackhole-command.test.ts"))).toBe(true);
  });
  it("does not allow real host, runtime or worker suites", () => {
    for (const file of ["runtime.test.ts", "inline-compaction.test.ts", "consolidation.test.ts"]) {
      expect(mayExerciseNormalDefaults(join(unitTestsDir, file))).toBe(false);
    }
  });
  it("does not allow nested or foreign files with matching basenames", () => {
    expect(mayExerciseNormalDefaults(join(unitTestsDir, "host", "config.test.ts"))).toBe(false);
    expect(mayExerciseNormalDefaults(join(unitTestsDir, "..", "config.test.ts"))).toBe(false);
    expect(mayExerciseNormalDefaults("")).toBe(false);
  });
  it("starts non-allowlisted cases with the inherited passive fence", () => {
    expect(process.env.PI_BLACKHOLE_PASSIVE).toBe(inheritedPassive);
    // Deliberately emulate source test cleanup removing the override.
    delete process.env.PI_BLACKHOLE_PASSIVE;
  });
  it("restores the fence for the next case", () => {
    expect(process.env.PI_BLACKHOLE_PASSIVE).toBe(inheritedPassive);
  });
});
