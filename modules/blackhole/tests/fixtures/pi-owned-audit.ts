import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): void {
  pi.on("session_before_compact", (event) => {
    const audit = (globalThis as any)[Symbol.for("blackhole-pi-owned-test-audit")];
    const p = event.preparation;
    audit.preparations.push({ firstKeptEntryId: p.firstKeptEntryId, tokensBefore: p.tokensBefore,
      messages: JSON.stringify([...p.messagesToSummarize, ...p.turnPrefixMessages]), prefixCount: p.turnPrefixMessages.length, reason: event.reason, settings: p.settings });
    audit.pending = true;
    if (audit.cancel) return { cancel: true };
  });
}
