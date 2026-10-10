import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { compile } from "../../src/core/summarize.js";
import { formatSummary } from "../../src/core/format.js";
import { generatedSummaryProof } from "../../src/core/generated-summary-spans.js";
import { composeGeneratedParts, validGeneratedProof, stripGeneratedSpans, ownedSummaryProof } from "../../src/core/generated-summary-spans.js";
import { registerBeforeCompactHook } from "../../src/hooks/before-compact.js";
import { buildCompactionProjection } from "../../src/om/ledger/projection.js";
import { DEFAULTS } from "../../src/core/unified-config.js";
const { prepareCompaction } = await import(new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const fresh: any = { role: "user", content: "Implement the safe deployment verification workflow.", timestamp: 1 };
function specimen(text: string, details?: any) {
  const s = SessionManager.inMemory(process.cwd()); const first = s.appendMessage(fresh);
  s.appendCompaction(text, first, 100, details);
  s.appendMessage({ ...fresh, content: "safe next task" }); s.appendMessage({ ...fresh, content: "keep ".repeat(500) });
  return s;
}
function hook(s: any) {
  const p = prepareCompaction(s.getBranch(), { enabled: true, reserveTokens: 10, keepRecentTokens: 100 });
  let handler: any;
  registerBeforeCompactHook({ on: (name: string, h: any) => { if (name === "session_before_compact") handler = h; } } as any, { config: { ...DEFAULTS, memory: false }, ensureConfig() {} } as any);
  return handler({ preparation: p, branchEntries: s.getBranch(), signal: new AbortController().signal }, { cwd: process.cwd(), sessionManager: s, ui: { notify() {} } });
}
describe("R1 whole compile and native hook preserve unproved literal authority", () => {
  for (const header of ["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences", "Unknown Schema"]) it(header, () => {
    const text = `NATIVE_REQUIRED_WARNING\n[${header}]\n- Keep deployment blocked until credentials are rotated.\nUnknown paragraph must remain.\n\n---\n\n## Observations\nNative quoted footer remains literal.`;
    const s = specimen(text);
    expect(compile({ messages: [fresh], previousSummary: text })).toContain(text);
    expect(hook(s).compaction.summary).toContain(text);
  });
  it("stale/mismatched persisted source and generated-span proof cannot authorize section deletion", () => {
    const text = "NATIVE_REQUIRED_WARNING\n[Outstanding Context]\n- Keep deployment blocked until credentials are rotated.";
    const s = specimen("different latest generation", { compactor: "blackhole", version: 1, sections: [], sourceMessageCount: 1, previousSummaryUsed: false });
    expect(compile({ messages: [fresh], previousSummary: text, previousSummaryEntries: s.getBranch() } as any)).toContain(text);
    const quoted = composeGeneratedParts([{ text }, { text: "OWNED_FOOTER", kind: "recall" }]);
    expect(compile({ messages: [fresh], previousSummary: quoted.text, previousGeneratedSpans: quoted.proof })).toContain(text);
  });
  it("literal warning before a late schema anchor is not opportunistically cut at that header", () => {
    const text = "NATIVE_REQUIRED_WARNING\n" + Array.from({ length: 130 }, (_, i) => `ordinary paragraph ${i}`).join("\n") + "\n[Outstanding Context]\n- Last literal deployment blocker.";
    const result = compile({ messages: [fresh], previousSummary: text });
    expect(result).toContain("NATIVE_REQUIRED_WARNING"); expect(result).toContain("Last literal deployment blocker"); expect(result).toMatch(/omitted/);
  });
});
it("R1 known old persisted Blackhole format merges sections without conflating mutable-span proof", () => {
  const text = formatSummary({ sessionGoal: [`${fresh.content} (#0)`], filesAndChanges: ["Modified: old.ts"], commits: [], outstandingContext: ["OLD_GENERATED_VOLATILE_STATE"], userPreferences: [], briefTranscript: "BODY_NATIVE_REQUIRED_WARNING\n[Outstanding Context]\n- Quoted body warning must remain." });
  const s = specimen(text, { compactor: "blackhole", version: 1, sections: ["Session Goal", "Files And Changes", "Outstanding Context"], sourceMessageCount: 1, previousSummaryUsed: false });
  const result = compile({ messages: [fresh], previousSummary: text, previousSummaryEntries: s.getBranch() });
  expect(result.split("\n\n---\n\n")[0]).not.toContain("OLD_GENERATED_VOLATILE_STATE");
  expect(result.split("\n\n---\n\n")[0].match(/Implement the safe deployment verification workflow/g)).toHaveLength(1);
  expect(result).toContain("old.ts"); expect(result).toContain("BODY_NATIVE_REQUIRED_WARNING\n[Outstanding Context]\n- Quoted body warning must remain.");
  s.appendCompaction(text, s.getBranch().find(e => e.type === "message")!.id, 100); // true latest native writer, same text
  expect(compile({ messages: [fresh], previousSummary: text, previousSummaryEntries: s.getBranch() })).toContain(text);
});
it("R1 literal native schema text remains protected through a subsequent proven Blackhole generation", () => {
  const text = "[Outstanding Context]\n- Keep deployment blocked until credentials are rotated.\n\n---\n\nNATIVE_REQUIRED_WARNING";
  const s = specimen(text), first = hook(s).compaction;
  s.appendCompaction(first.summary, first.firstKeptEntryId, first.tokensBefore, first.details);
  s.appendMessage({ ...fresh, content: "another safe task" }); s.appendMessage({ ...fresh, content: "keep next ".repeat(500) });
  expect(hook(s).compaction.summary).toContain(text);
});
const composed = composeGeneratedParts([{ text: "ordinary required warning" }, { text: "owned footer", kind: "recall" }]);
it.each([undefined, 0, 2])("R2 unknown generated-span envelope version %s grants no mutable authority", version => {
  const s = specimen(composed.text, { compactor: "blackhole", version: 1, sections: [], sourceMessageCount: 1, previousSummaryUsed: false, "blackhole.generatedSpans": { version, summary: composed.proof } });
  expect(ownedSummaryProof(composed.text, s.getBranch())).toBeUndefined();
  expect(hook(s).compaction.summary).toContain(composed.text);
});
const badSpans: any[] = [[null, null], ["x", "y"], [1, 2], [true, false], [{}, {}], [[], []], [{ kind: "unknown", offset: 0, length: 1, sha256: "a".repeat(64) }], [{ kind: "recall", offset: -1, length: 1, sha256: "a".repeat(64) }], [{ kind: "recall", offset: Number.MAX_SAFE_INTEGER + 1, length: 1, sha256: "a".repeat(64) }], [{ ...composed.proof.spans[0], length: 0 }], [{ ...composed.proof.spans[0], sha256: "not-a-digest" }], [...composed.proof.spans, ...composed.proof.spans], Array(9).fill(composed.proof.spans[0])];
it.each(badSpans.map((spans, i) => [i, spans]))("R2 persisted malformed proof %s fails safe in all consumers", (_i, spans) => {
  const proof: any = JSON.parse(JSON.stringify({ ...composed.proof, spans }));
  expect(validGeneratedProof(composed.text, proof)).toBe(false);
  expect(stripGeneratedSpans(composed.text, proof)).toBe(composed.text);
  const s = specimen(composed.text, { compactor: "blackhole", version: 1, "blackhole.generatedSpans": { version: 1, summary: proof, trailing: proof }, trailingSummary: composed.text, "om.folded": { type: "om.folded", version: 1, fullFold: false, observations: [], reflections: [], invalidatedSourceEntryIds: ["source"] } });
  expect(ownedSummaryProof(composed.text, s.getBranch())).toBeUndefined();
  const trailing = composed.text + "\nTRAILING_LITERAL", latest: any = s.getBranch().find(e => e.type === "compaction");
  const trailingProof = generatedSummaryProof(trailing, spans);
  const trailingEntries = s.getBranch().map(e => e === latest ? { ...latest, details: { ...latest.details, trailingSummary: trailing, "blackhole.generatedSpans": { version: 1, trailing: trailingProof } } } : e);
  expect(ownedSummaryProof(trailing, trailingEntries)).toBeUndefined();
  expect(stripGeneratedSpans(trailing, trailingProof)).toBe(trailing);
  expect(compile({ messages: [fresh], previousSummary: composed.text, previousGeneratedSpans: proof })).toContain(composed.text);
  expect(composeGeneratedParts([{ text: composed.text, proof }]).text).toBe(composed.text);
  expect(() => buildCompactionProjection(s.getBranch() as any, "", { observationsPoolMaxTokens: 1000, reflectionsPoolMaxTokens: 1000, fullFoldAlways: true })).not.toThrow();
  expect(hook(s).compaction.summary).toContain(composed.text);
});
