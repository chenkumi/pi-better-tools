import { describe, expect, it } from "vitest";
import { selectOmittedAssistantText } from "../src/hooks/cosmetic-output.js";

// Pi getBranch() is chronological (root -> leaf), not newest first.
const answer = (id: string, text: string) => ({
  id, type: "message" as const,
  message: { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop" as const },
});
const compaction = { id: "compact", type: "compaction" as const };

describe("cosmetic output with Pi chronological branches", () => {
  it("copies the final answer preceding a compact-all entry", () => {
    const branch = [answer("older", "older output"), answer("final", "FINAL ANSWER"), compaction];
    expect(selectOmittedAssistantText({ branch: branch as never, retainedIds: new Set(["compact"]), compactionEntryId: "compact" }))
      .toEqual({ entryId: "final", text: "FINAL ANSWER" });
  });

  it("never selects output created after the compaction boundary", () => {
    const branch = [answer("final", "FINAL ANSWER"), compaction, answer("later", "LATER OUTPUT")];
    expect(selectOmittedAssistantText({ branch: branch as never, retainedIds: new Set(["compact"]), compactionEntryId: "compact" }))
      .toEqual({ entryId: "final", text: "FINAL ANSWER" });
  });

  it("respects the backwards scan budget", () => {
    const branch = [answer("final", "FINAL ANSWER"), { type: "custom" as const, id: "metadata" }, compaction];
    expect(selectOmittedAssistantText({ branch: branch as never, retainedIds: new Set(["compact"]), compactionEntryId: "compact", maxScan: 1 }))
      .toBeUndefined();
  });

  it("includes a candidate exactly at the backwards scan budget", () => {
    const branch = [answer("final", "FINAL ANSWER"), { type: "custom" as const, id: "metadata" }, compaction];
    expect(selectOmittedAssistantText({ branch: branch as never, retainedIds: new Set(["compact"]), compactionEntryId: "compact", maxScan: 2 }))
      .toEqual({ entryId: "final", text: "FINAL ANSWER" });
  });

  it("does not copy an answer retained in model context", () => {
    const branch = [answer("final", "FINAL ANSWER"), compaction];
    expect(selectOmittedAssistantText({ branch: branch as never, retainedIds: new Set(["compact", "final"]), compactionEntryId: "compact" }))
      .toBeUndefined();
  });
});
