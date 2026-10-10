/**
 * H01 (Pi 1.1.0 host defect, see h01-duplicate-summary-upstream.integration.test.mjs): with duplicate summaries the
 * host may emit session_compact referencing an OLDER checkpoint. Blackhole must fail safe: acknowledge a pending
 * flush only for the exact entry that carries the receipt and sits after the receipt's branch tip. Anything else must
 * leave pending state intact (no commit/clear) so the batch is retried.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const commit = vi.hoisted(() => vi.fn(() => true));
vi.mock("../src/om/manual-pending.js", async (orig) => ({
  ...(await orig<typeof import("../src/om/manual-pending.js")>()),
  commitManualPending: commit,
}));

import { registerBeforeCompactHook } from "../src/hooks/before-compact.js";
import { PENDING_FLUSH_KEY } from "../src/om/manual-pending.js";

const receipt = { version: 1, sessionId: "s1", branchTipId: "tip", snapshot: "fp-1" };
const checkpoint = (id: string, withReceipt: boolean) => ({
  id, type: "compaction", summary: "SAME", firstKeptEntryId: "k", tokensBefore: 1,
  details: withReceipt ? { compactor: "blackhole", [PENDING_FLUSH_KEY]: receipt } : { compactor: "blackhole" },
});

function setup(branch: unknown[], sessionId = "s1") {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = { on: (name: string, handler: any) => handlers.set(name, handler), appendEntry: vi.fn() };
  const runtime: any = { config: {}, compactWasPiVcc: false, compactionStats: null };
  registerBeforeCompactHook(pi as any, runtime);
  const notify = vi.fn();
  const ctx = { ui: { notify }, sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } };
  return { fire: (entry: unknown) => handlers.get("session_compact")!({ compactionEntry: entry, fromExtension: true }, ctx), notify };
}

describe("H01 wrong session_compact receipt fails safe", () => {
  beforeEach(() => commit.mockClear());

  it("positive control: exact receipt-bearing entry after the tip is acknowledged", () => {
    const newest = checkpoint("new", true);
    setup([{ id: "tip", type: "message" }, newest]).fire(newest);
    expect(commit).toHaveBeenCalledWith("s1", "fp-1");
  });

  it("event pointing at an older same-summary checkpoint (no receipt) does not ack or clear pending", () => {
    const old = checkpoint("old", false), newest = checkpoint("new", true);
    const { fire } = setup([old, { id: "tip", type: "message" }, newest]);
    fire(old);
    expect(commit).not.toHaveBeenCalled();
  });

  it("receipt entry located before the receipt's branch tip is rejected", () => {
    const stale = checkpoint("old", true);
    setup([stale, { id: "tip", type: "message" }]).fire(stale);
    expect(commit).not.toHaveBeenCalled();
  });

  it("receipt from another session is rejected", () => {
    const newest = checkpoint("new", true);
    setup([{ id: "tip", type: "message" }, newest], "other-session").fire(newest);
    expect(commit).not.toHaveBeenCalled();
  });

  it("entry that is not on the current branch is rejected", () => {
    setup([{ id: "tip", type: "message" }]).fire(checkpoint("elsewhere", true));
    expect(commit).not.toHaveBeenCalled();
  });
});
