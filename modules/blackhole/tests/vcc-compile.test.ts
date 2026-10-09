import { describe, it, expect } from "vitest";
import { compile } from "../src/core/summarize.js";
import { composeGeneratedParts, type GeneratedSummaryProof } from "../src/core/generated-summary-spans.js";
import { userMsg, assistantText, assistantWithToolCall } from "./vcc-fixtures.js";

describe("compile", () => {
  it("returns empty string for no messages", () => {
    expect(compile({ messages: [] })).toBe("");
  });

  it("produces hybrid output with header + brief transcript", () => {
    const r = compile({
      messages: [
        userMsg("Fix login bug"),
        assistantWithToolCall("Read", { path: "auth.ts" }),
        assistantText("Found the issue.\n1. Fix validation"),
      ],
    });
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("Fix login bug");
    expect(r).toContain("---");
    expect(r).toContain("[user]\nFix login bug");
    expect(r).toContain('* Read "auth.ts"');
    expect(r).toContain("Found the issue.");
  });

  it("merges previous summary goals", () => {
    const r = compile({
      messages: [userMsg("New task")],
      previousSummary: "[Session Goal]\n- Original goal\n\n---\n\n[user]\nOriginal goal",
    });
    expect(r).toContain("- Original goal");
    expect(r).toContain("- New task");
  });

  it("appends brief transcript on merge", () => {
    const previousSummary = [
      "[Session Goal]\n- Original goal",
      "---",
      '[user]\nOriginal goal\n\n[assistant]\n* Read "old.ts"',
    ].join("\n\n");
    const r = compile({
      previousSummary,
      messages: [userMsg("Next step"), assistantWithToolCall("Read", { path: "new.ts" })],
    });
    expect(r).toContain('* Read "old.ts"');
    expect(r).toContain('* Read "new.ts"');
    expect(r).toContain("Next step");
  });

  it("outstanding context is volatile (fresh only)", () => {
    const previousSummary = "[Outstanding Context]\n- old blocker\n\n---\n\n[user]\nhi";
    const r = compile({
      previousSummary,
      messages: [userMsg("continue")],
    });
    expect(r).not.toContain("old blocker");
  });

  it("caps long brief transcript with rolling window", () => {
    // Build a very long previous transcript
    const longTranscript = Array.from({ length: 200 }, (_, i) => `[user]\nmessage ${i}`).join(
      "\n\n",
    );
    const previousSummary = `[Session Goal]\n- goal\n\n---\n\n${longTranscript}`;
    const r = compile({
      previousSummary,
      messages: [userMsg("latest")],
    });
    expect(r).toContain("earlier lines omitted");
    expect(r).toContain("latest");
  });

  it("wraps final output with reasonable line lengths", () => {
    const r = compile({
      messages: [userMsg("check final summary wrapping")],
    });
    // RECALL_NOTE is appended by compile() itself (wrapped with the rest).
    const maxLineLength = Math.max(...r.split("\n").map((line) => line.length));
    expect(maxLineLength).toBeLessThanOrEqual(120);
  });

  describe("compile — proven generated-span deduplication", () => {
    it("strips the actual wrapped generated recall note from a previous generation", () => {
      let proof: GeneratedSummaryProof | undefined;
      const previousSummary = compile({ messages: [userMsg("goal")], onGeneratedSpans: p => { proof = p; } });
      const r = compile({ messages: [userMsg("next")], previousSummary, previousGeneratedSpans: proof });
      expect((r.match(/The conversation before this point has been compacted/g) || []).length).toBe(1);
      expect(r).toContain("goal");
    });
    it("strips only composed OM/recall spans and retains identically headed user quotations", () => {
      let proof: GeneratedSummaryProof | undefined;
      const body = compile({ messages: [userMsg("goal\n## Observations\nKeep deployment blocked")], onGeneratedSpans: p => { proof = p; } });
      const previous = composeGeneratedParts([{ text: body, proof }, { text: "## Reflections\nOld reflection\n\n## Observations\nOld observation", kind: "om" }]);
      const r = compile({ messages: [userMsg("next")], previousSummary: previous.text, previousGeneratedSpans: previous.proof });
      expect(r).not.toContain("Old reflection"); expect(r).not.toContain("Old observation");
      expect(r).toContain("Keep deployment blocked");
      expect((r.match(/The conversation before this point has been compacted/g) || []).length).toBe(1);
    });
    it("deduplicates generated recall notes across three compaction cycles", () => {
      let summary = "", proof: GeneratedSummaryProof | undefined;
      for (const task of ["first substantive deployment task", "second substantive deployment task", "third substantive deployment task"]) {
        summary = compile({ messages: [userMsg(task)], previousSummary: summary, previousGeneratedSpans: proof, onGeneratedSpans: p => { proof = p; } });
        expect((summary.match(/The conversation before this point has been compacted/g) || []).length).toBe(1);
        expect(summary).toContain(task);
      }
    });
  });
});
