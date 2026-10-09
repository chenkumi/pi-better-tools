import { expect, it } from "vitest";
import { piOwnedSettingsWarning } from "../src/core/pi-owned-settings.js";
it("diagnoses even the historic 81000 file residue without selecting a new threshold", () => {
  const raw = { compactAfterTokens: 81000, midRunCompaction: "resume", tailBehavior: "minimal" };
  const before = structuredClone(raw);
  expect(piOwnedSettingsWarning(raw)).toContain("compactAfterTokens, midRunCompaction, tailBehavior");
  expect(piOwnedSettingsWarning(raw)).toContain("no Blackhole threshold is applied");
  expect(raw).toEqual(before);
});
it("summary-only defaults need no new timing key or compulsory legacy warning", () => {
  expect(piOwnedSettingsWarning({ compaction: "auto", compactionEngine: "blackhole" })).toBeUndefined();
});
