const legacyTimingKeys = ["compactAfterTokens", "compactAfterRatio", "compactReserveTokens", "compactAfterPreset", "compactAfterPresets", "midRunCompaction", "tailBehavior", "retainedToolOutputMaxTokens"] as const;

/** Canonical writes remove inactive controls, not user preset definitions or active aliases. */
export const IGNORED_CONTROL_KEYS = legacyTimingKeys.filter(key => key !== "compactAfterPresets");
export function canonicalPersistedSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw };
  for (const key of IGNORED_CONTROL_KEYS) delete result[key];
  return result;
}

/** Diagnose explicit compatibility keys without rewriting files or manufacturing a Pi threshold. */
export function piOwnedSettingsWarning(raw: Record<string, unknown>): string | undefined {
  const present = legacyTimingKeys.filter(key => raw[key] !== undefined);
  if (!present.length) return;
  return `blackhole: Pi owns compaction timing and retained context. Legacy settings (${present.join(", ")}) are readable but do not control this mode. Configure Pi compaction.enabled/reserveTokens/keepRecentTokens instead; no Blackhole threshold is applied.`;
}
