import { buildSessionProjection } from "@earendil-works/pi-coding-agent";

/** Unit fixture only: caller supplies the cut; public Pi projection supplies all content. Not a cut algorithm. */
export function fixtureNativePreparation(branch: any[], firstKeptEntryId: string, previousSummary?: string) {
  // Historical unit arrays omit parentId; materialize their explicitly supplied lineage.
  const entries = branch.map((entry, i) => ({ ...entry, parentId: entry.parentId ?? branch[i - 1]?.id ?? null }));
  const projection = buildSessionProjection(entries);
  const cut = projection.entries.findIndex(entry => entry.sourceEntry.id === firstKeptEntryId);
  const selected = cut >= 0 ? projection.entries.slice(0, cut) : projection.entries;
  return {
    firstKeptEntryId, previousSummary, tokensBefore: 1000, isSplitTurn: false,
    messagesToSummarize: selected.flatMap(entry => entry.messages).filter(message => message.role !== "compactionSummary"),
    turnPrefixMessages: [],
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 0 },
  };
}
