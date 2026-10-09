import { relative } from "node:path";
import { fileURLToPath } from "node:url";

export const unitTestsDir = fileURLToPath(new URL("../", import.meta.url));
const configContracts = new Set([
  "config.test.ts", "config-observer-guard.test.ts", "config-simplification.test.ts",
  "manual-mode-migration.test.ts", "migration-notice.test.ts", "blackhole-command.test.ts",
]);

/** Exact audited files only, not arbitrary files with a matching basename. */
export function mayExerciseNormalDefaults(testPath: string): boolean {
  return configContracts.has(relative(unitTestsDir, testPath).replace(/\\/g, "/"));
}
