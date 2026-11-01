import { expect, it } from "vitest";
import { canonicalPersistedSettings, piOwnedSettingsWarning } from "../src/core/pi-owned-settings.js";
import { DEFAULTS } from "../src/core/unified-config.js";
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
it("a retired key left in an old file is never read, never warned about, and dropped by an explicit save", () => {
  const raw = { debugLog: true, observationsPoolTargetTokens: 5000 };
  expect("observationsPoolTargetTokens" in DEFAULTS).toBe(false);
  expect(piOwnedSettingsWarning(raw)).toBeUndefined();
  expect(canonicalPersistedSettings(raw)).toEqual({ debugLog: true });
  expect(raw).toEqual({ debugLog: true, observationsPoolTargetTokens: 5000 });
});
