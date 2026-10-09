import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Test-only public-event observer. It never returns a summary/cancel/cut or mutates
// preparation. Kept separate because prepareCompaction is not a root SDK export.
export default function (pi: ExtensionAPI): void {
  pi.on('session_before_compact', event => {
    const records = (globalThis as any)[Symbol.for('pi-better-tools.blackhole-display-native-audit')];
    if (!Array.isArray(records)) throw new Error('Missing isolated Blackhole display audit');
    const p = event.preparation;
    records.push(structuredClone({ firstKeptEntryId: p.firstKeptEntryId, tokensBefore: p.tokensBefore,
      messagesToSummarize: p.messagesToSummarize, turnPrefixMessages: p.turnPrefixMessages,
      isSplitTurn: p.isSplitTurn, previousSummary: p.previousSummary, settings: p.settings,
      reason: event.reason, willRetry: event.willRetry, customInstructions: event.customInstructions,
      branchIds: event.branchEntries.map(entry => entry.id) }));
  });
}
