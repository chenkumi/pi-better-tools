import { describe, expect, it } from "vitest";
import {
  compile,
  compileSegment,
  extractRecallNote,
  stripRecallNotes,
} from "../src/core/summarize.js";

import { composeGeneratedParts, type GeneratedSummaryProof } from "../src/core/generated-summary-spans.js";
const fileOps = { readFiles: [], modifiedFiles: [] };

describe("append VCC compilation", () => {
  it("builds a fresh segment without the prior summary or recall note", () => {
    const messages = [
      { role: "user", content: "Implement append compaction." },
      { role: "assistant", content: "Added the first immutable segment." },
    ] as any[];
    const previousSummary =
      "[Session Goal]\n- old state\n\nThe conversation before this point has been compacted.";

    const segment = compileSegment({ messages, fileOps });
    let proof: GeneratedSummaryProof | undefined;
    const complete = compile({ messages, previousSummary, fileOps, onGeneratedSpans: p => { proof = p; } });

    expect(segment).not.toContain("old state");
    expect(segment).not.toContain("The conversation before this point has been compacted");
    expect(complete).toContain("- old state");
    expect(extractRecallNote(complete, proof)).toContain(
      "The conversation before this point has been compacted",
    );
  });

  it("removes only composed wrapped recall spans, preserving unproved identical quotations", () => {
    const text = [
      "[Goal]\nkeep",
      "The conversation before this point has been compacted, but the original\nentries remain available through recall.",
      "[Progress]\nkeep this too",
      "The conversation before this point has been compacted again.",
    ].join("\n\n");

    expect(stripRecallNotes(text)).toBe(text);
    const composed = composeGeneratedParts([{ text: "[Goal]\nkeep" }, { text: "The conversation before this point has been compacted, but the original\nentries remain available through recall.", kind: "recall" }, { text: "[Progress]\nkeep this too" }, { text: "The conversation before this point has been compacted again.", kind: "recall" }]);
    expect(composed.text).toBe(text);
    const cleaned = stripRecallNotes(composed.text, composed.proof);
    expect(cleaned).toContain("[Goal]");
    expect(cleaned).toContain("[Progress]");
    expect(cleaned).not.toContain("conversation before this point");
  });
});
