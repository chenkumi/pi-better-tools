import { expect, it } from "vitest";
import { registerBeforeCompactHook } from "../src/hooks/before-compact.js";
import { DEFAULTS } from "../src/core/unified-config.js";
const msg = (role: string, text: string) => ({ role, content: [{ type: "text", text }], timestamp: 1 });
function run(messages: any[], prefix: any[] = [], overrides: any = {}) {
  const handlers = new Map<string, Function>();
  const excluded = msg("user", "OMITTED_RAW_SECRET_MUST_NOT_RETURN");
  const branch = [{ type: "message", id: "omitted", message: excluded },
    ...messages.map((message, i) => ({ type: "message", id: `m${i}`, message })),
    ...prefix.map((message, i) => ({ type: "message", id: `p${i}`, message })),
    { type: "message", id: "native-kept", message: msg("user", "NATIVE_KEPT_MUST_NOT_SUMMARIZE") },
    { type: "message", id: "later-kept", message: msg("assistant", "Native retained response") }];
  const runtime: any = { config: { ...DEFAULTS, compaction: "auto", memory: false, tailBehavior: "minimal", ...overrides }, ensureConfig() {} };
  registerBeforeCompactHook({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any, runtime);
  const preparation = { messagesToSummarize: messages, turnPrefixMessages: prefix, isSplitTurn: prefix.length > 0,
    firstKeptEntryId: "native-kept", tokensBefore: 12345, previousSummary: undefined,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 50 } };
  const result = handlers.get("session_before_compact")!({ preparation, branchEntries: branch, reason: "manual", signal: new AbortController().signal },
    { cwd: process.cwd(), sessionManager: { getEntries: () => branch, getBranch: () => branch }, ui: { notify() {} } });
  return { result, preparation };
}
it("Pi-owned summary must use only authoritative preparation and preserve native boundary/tokens despite legacy minimal", () => {
  const { result } = run([msg("user", "Implement PROJECTED_INPUT_ONLY"), msg("assistant", "completed PROJECTED_RESULT_ONLY")]);
  expect(result?.compaction?.firstKeptEntryId).toBe("native-kept");
  expect(result?.compaction?.tokensBefore).toBe(12345);
  expect(result?.compaction?.summary).toContain("PROJECTED_INPUT_ONLY");
  expect(result?.compaction?.summary).not.toContain("OMITTED_RAW_SECRET_MUST_NOT_RETURN");
  expect(result?.compaction?.summary).not.toContain("NATIVE_KEPT_MUST_NOT_SUMMARIZE");
  expect(result?.compaction?.details?.retainedToolOutputProjection?.omissions ?? []).toEqual([]);
});
it("Pi-owned split prefix is summarized even without a full earlier user span", () => {
  const { result } = run([], [msg("user", "Implement SPLIT_NATIVE_PREFIX"), msg("assistant", "completed SPLIT_NATIVE_RESULT")]);
  expect(result?.compaction?.firstKeptEntryId).toBe("native-kept");
  expect(result?.compaction?.summary).toContain("SPLIT_NATIVE_PREFIX");
  expect(result?.compaction?.summary).toContain("SPLIT_NATIVE_RESULT");
  expect(result?.compaction?.summary).not.toContain("OMITTED_RAW_SECRET_MUST_NOT_RETURN");
});
it("Empty native summary input declines to Pi without harvesting raw omitted history or cancelling native ownership", () => {
  const { result } = run([]);
  expect(result).toBeUndefined();
});
