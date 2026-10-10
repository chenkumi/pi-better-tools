import { SessionManager } from "@earendil-works/pi-coding-agent";
/** Positive compatibility fixture: an actual persisted-in-session old Blackhole
 * writer record. Never use for native/unproved literal-retention test cases.
 * This grants no generated OM/recall spans and does not manufacture their proof.
 */
export function persistedSummaryEntries(summary: string) {
  const s = SessionManager.inMemory(process.cwd());
  s.appendMessage({ role: "user", content: "Prior Blackhole structured-format fixture.", timestamp: 1 });
  s.appendCompaction(summary, "", 100, { compactor: "blackhole", version: 1, sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map(m => m[1]), sourceMessageCount: 1, previousSummaryUsed: false });
  return s.getBranch();
}
