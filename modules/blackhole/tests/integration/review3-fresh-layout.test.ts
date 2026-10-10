import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { compile, compileSegment } from "../../src/core/summarize.js";
import { ownedSummaryLayout, summaryFormatProof } from "../../src/core/summary-format.js";
import { registerBeforeCompactHook } from "../../src/hooks/before-compact.js";
import { DEFAULTS } from "../../src/core/unified-config.js";
const { prepareCompaction } = await import(new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const warning = "MANDATORY_NEW_WARNING: rotate credentials before deployment.";
const assistant = (text: string): any => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "offline", model: "fixture", stopReason: "stop", timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const previous = "[Session Goal]\n- Implement safe release workflow.\n\n---\n\n[user]\nPrevious task.";
function persisted(layout: "structured-v1" | "literal-brief-v1", summary = previous) {
  const sm = SessionManager.inMemory(process.cwd());
  sm.appendMessage({ role: "user", content: "Prior task", timestamp: 1 });
  const a = sm.appendMessage(assistant(warning));
  sm.appendCompaction(summary, a, 100, { compactor: "blackhole", version: 1, sections: ["Session Goal"], sourceMessageCount: 1, previousSummaryUsed: false, "blackhole.summaryFormat": summaryFormatProof(summary, layout) });
  expect(ownedSummaryLayout(summary, sm.getBranch())).toBe(layout);
  return sm;
}
describe.each(["structured-v1", "literal-brief-v1"] as const)("S1 fresh composition with persisted %s", layout => {
  it("retains nonempty headerless warning (compileSegment positive control)", () => {
    const sm = persisted(layout), messages = [assistant(warning)];
    const segment = compileSegment({ messages });
    expect(segment).toContain(warning); expect(segment).not.toContain("\n\n---\n\n");
    const result = compile({ messages, previousSummary: previous, previousSummaryEntries: sm.getBranch() });
    expect(result).toContain(warning); expect(result).toContain("Implement safe release workflow.");
    expect(result).toContain("[user]\nPrevious task.");
  });
  it("empty fresh does not invent sections or lose prior body", () => {
    const sm = persisted(layout);
    expect(compileSegment({ messages: [] })).toBe("");
    const result = compile({ messages: [], previousSummary: previous, previousSummaryEntries: sm.getBranch() });
    expect(result).toContain(previous);
  });
  it("ordinary role markers and quoted headers/separators remain literal, never fresh schema", () => {
    const sm = persisted(layout);
    const text = `${warning}\n[Outstanding Context]\n- QUOTED_NOT_SCHEMA\n\n---\n\n[Session Goal]\n- QUOTED_NOT_A_GOAL`;
    const messages = [assistant(text)], segment = compileSegment({ messages });
    expect(segment).toContain("[assistant]"); expect(segment).toContain("QUOTED_NOT_A_GOAL");
    const result = compile({ messages, previousSummary: previous, previousSummaryEntries: sm.getBranch() });
    expect(result).toContain(segment);
    const prefix = result.split("\n\n---\n\n")[0];
    expect(prefix).not.toContain("QUOTED_NOT_SCHEMA"); expect(prefix).not.toContain("QUOTED_NOT_A_GOAL");
  });
  it("normally generated fresh structured prefix still merges", () => {
    const sm = persisted(layout), messages: any = [{ role: "user", content: "Implement credential rotation verification workflow.", timestamp: 2 }, assistant(warning)];
    const result = compile({ messages, previousSummary: previous, previousSummaryEntries: sm.getBranch() });
    expect(result.split("\n\n---\n\n")[0]).toContain("Implement credential rotation verification workflow.");
    expect(result).toContain(warning); expect(result).toContain("Implement safe release workflow.");
  });
  it("installed authoritative preparation contains retained assistant warning, exact previous and native cut", () => {
    const sm = persisted(layout), k = sm.appendMessage({ role: "user", content: "keep ".repeat(1000), timestamp: 2 });
    const branch = sm.getBranch(), settings = { enabled: true, reserveTokens: 10, keepRecentTokens: 100 };
    const preparation = prepareCompaction(branch, settings);
    expect(preparation).toBeDefined(); expect(preparation.previousSummary).toBe(previous);
    expect(preparation.firstKeptEntryId).toBe(k); expect(preparation.settings).toEqual(settings);
    expect([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]).toEqual([assistant(warning)]);
    let hook: any;
    registerBeforeCompactHook({ on(name: string, handler: any) { if (name === "session_before_compact") hook = handler; } } as any, { config: { ...DEFAULTS, memory: false, compaction: "auto", compactionSummaryMode: "default" }, ensureConfig() {} } as any);
    const raw = JSON.stringify(branch);
    const result = hook({ preparation, branchEntries: branch, signal: new AbortController().signal }, { cwd: process.cwd(), sessionManager: sm, hasUI: false, ui: { notify() {} } });
    expect(result.compaction.firstKeptEntryId).toBe(k); expect(result.compaction.tokensBefore).toBe(preparation.tokensBefore);
    expect(result.compaction.summary).toContain(warning); expect(JSON.stringify(sm.getBranch())).toBe(raw);
  });
});
it("S1 native/unproved previous remains literal with headerless fresh", () => {
  const text = "[Outstanding Context]\n- NATIVE_REQUIRED_WARNING\n\n---\n\nLiteral native previous.";
  const sm = SessionManager.inMemory(process.cwd()); const id = sm.appendMessage(assistant("Prior")); sm.appendCompaction(text, id, 100);
  const result = compile({ messages: [assistant(warning)], previousSummary: text, previousSummaryEntries: sm.getBranch() });
  expect(result).toContain(text); expect(result).toContain(warning); expect(ownedSummaryLayout(text, sm.getBranch())).toBeUndefined();
});
