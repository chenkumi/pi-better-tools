const legacyTimingKeys = ["compactAfterTokens", "compactAfterRatio", "compactReserveTokens", "compactAfterPreset", "compactAfterPresets", "midRunCompaction", "tailBehavior", "retainedToolOutputMaxTokens"] as const;

/** Diagnose explicit compatibility keys without rewriting files or manufacturing a Pi threshold. */
export function piOwnedSettingsWarning(raw: Record<string, unknown>): string | undefined {
  const present = legacyTimingKeys.filter(key => raw[key] !== undefined);
  if (!present.length) return;
  return `blackhole: Pi owns compaction timing and retained context. Legacy settings (${present.join(", ")}) are readable but do not control this mode. Configure Pi compaction.enabled/reserveTokens/keepRecentTokens instead; no Blackhole threshold is applied.`;
}
