import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildExportMarkdown, buildExportMarkdownAsync } from "../src/project-recall/format-export.js";
import type { ProjectCorpus } from "../src/project-recall/corpus.js";

function corpus(count: number): ProjectCorpus {
  const observations = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    content: createHash("sha256").update(String(i)).digest("hex"),
    relevance: "low" as const,
    timestamp: null,
    sessionId: "synthetic",
    source: "branch" as const,
  }));
  return {
    projectRoot: "synthetic",
    sessionsConsidered: 1,
    filesWithMarkers: 1,
    observations,
    reflections: [],
    droppedIds: new Set(),
    knownSessionIds: new Set(["synthetic"]),
    orphanedSessions: 0,
  } as ProjectCorpus;
}

describe("project export keeps the event loop running", () => {
  it("lets other macrotasks run while clustering and renders the same markdown as the sync build", async () => {
    const input = corpus(200);
    const options = { now: Date.UTC(2026, 0, 1), title: "synthetic" };
    let ticks = 0;
    let running = true;
    const spin = () => {
      if (!running) return;
      ticks += 1;
      setImmediate(spin);
    };
    setImmediate(spin);
    const asyncResult = await buildExportMarkdownAsync(input, options);
    running = false;

    expect(ticks).toBeGreaterThan(5);
    expect(asyncResult).toEqual(buildExportMarkdown(input, options));
  });
});
