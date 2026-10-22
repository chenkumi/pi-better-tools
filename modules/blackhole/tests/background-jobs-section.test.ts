import { describe, expect, it, vi } from "vitest";
import { renderBackgroundJobs } from "../src/core/background-jobs-section.js";
import { composeGeneratedParts, stripGeneratedSpans, validGeneratedProof } from "../src/core/generated-summary-spans.js";
import { compile } from "../src/core/summarize.js";
import { registerBeforeCompactHook } from "../src/hooks/before-compact.js";
import { publishCapability, canonicalMonitorCwd } from "../../shell-tools/src/monitor-capability.js";
import { fixtureNativePreparation } from "./fixtures/native-preparation.js";

const brief = (kind: any, jobId: string, status = "running") => ({ kind, jobId, status });

describe("renderBackgroundJobs", () => {
  it("renders nothing when no job is live and nothing was lost", () => {
    expect(renderBackgroundJobs([], false)).toBe("");
  });
  it("lists shell, subagent and fork jobs by id only, with the staleness warning", () => {
    const text = renderBackgroundJobs([brief("shell_job", "SH1"), brief("subagent_job", "SA1", "queued"), brief("fork_job", "FK1", "blocked")], false);
    expect(text.split("\n")[0]).toMatch(/^\[Background Jobs — live at compaction time/);
    expect(text).toContain("- Shell Job: SH1 (running)");
    expect(text).toContain("- Subagent Job: SA1 (queued)");
    expect(text).toContain("- Fork Job: FK1 (blocked)");
    expect(text).toMatch(/do not assume .*still running/i);
  });
  it("drops ids that are not plain identifiers and marks the list partial", () => {
    const text = renderBackgroundJobs([brief("shell_job", "ok-1"), brief("shell_job", "bad\nid; rm -rf"), brief("fork_job", "\u001b[31mred")], false);
    expect(text).toContain("ok-1");
    expect(text).not.toMatch(/rm -rf|\u001b/);
    expect(text).toMatch(/partial/i);
  });
  it("caps the listing at 16 rows and says so", () => {
    const rows = Array.from({ length: 20 }, (_, i) => brief("shell_job", `J${i}`));
    const text = renderBackgroundJobs(rows, false);
    expect(text.match(/^- Shell Job:/gm)).toHaveLength(16);
    expect(text).toMatch(/partial/i);
  });
  it("does not let a full shell list crowd out fork and subagent jobs", () => {
    const rows = [
      ...Array.from({ length: 16 }, (_, i) => brief("shell_job", `J${i}`)),
      brief("subagent_job", "SA1"),
      brief("fork_job", "FK1"),
      brief("fork_job", "FK2"),
    ];
    const text = renderBackgroundJobs(rows, false);
    expect(text.match(/^- /gm)!.length).toBeLessThanOrEqual(17);
    expect(text).toContain("- Subagent Job: SA1");
    expect(text).toContain("- Fork Job: FK1");
    expect(text).toContain("- Fork Job: FK2");
    expect(text).toMatch(/partial/i);
  });
});

describe("generated 'jobs' span", () => {
  it("is proven by composition and removed as a generated span", () => {
    const section = renderBackgroundJobs([brief("fork_job", "FK1")], false);
    const composed = composeGeneratedParts([{ text: "[Session Goal]\n- x" }, { text: section, kind: "jobs" }, { text: "tail", kind: "om" }]);
    expect(validGeneratedProof(composed.text, composed.proof)).toBe(true);
    expect(composed.proof.spans.map(s => s.kind)).toEqual(["jobs", "om"]);
    const stripped = stripGeneratedSpans(composed.text, composed.proof);
    expect(stripped).not.toContain("FK1");
    expect(stripped).toContain("[Session Goal]");
  });
  it("a later compile never carries a proven previous jobs section forward", () => {
    const section = renderBackgroundJobs([brief("fork_job", "FK-STALE")], false);
    const composed = composeGeneratedParts([{ text: "[Session Goal]\n- Fix auth" }, { text: section, kind: "jobs" }]);
    const next = compile({ messages: [{ role: "user", content: "next step" }] as any, previousSummary: composed.text, previousGeneratedSpans: composed.proof, fileOps: { readFiles: [], modifiedFiles: [] }, cwd: process.cwd() } as any);
    expect(next).not.toContain("FK-STALE");
    expect(next).not.toContain("[Background Jobs");
  });
});

describe("before-compact hook", () => {
  const msg = (id: string, role: string, content: string) => ({ id, type: "message", timestamp: Date.now(), message: { role, content } });
  const run = (sessionId: string, summaryMode = "default") => {
    let handler: any;
    const runtime: any = { ensureConfig: vi.fn(), config: { compaction: "auto", compactionEngine: "blackhole", compactionSummaryMode: summaryMode, memory: false, skipForProviders: [], debug: false, debugLog: false, observationsPoolMaxTokens: 20000, reflectionsPoolMaxTokens: 8000, fullFoldAlways: true }, compactWasPiVcc: false, compactionStats: null, appendFallbackNotified: false };
    registerBeforeCompactHook({ on: (e: string, cb: any) => { if (e === "session_before_compact") handler = cb; } } as any, runtime);
    const branchEntries = [msg("m1", "user", "fix the auth bug"), msg("m2", "assistant", "looking"), msg("m3", "user", "continue")];
    return handler({ type: "session_before_compact", reason: "threshold", customInstructions: undefined, branchEntries, preparation: fixtureNativePreparation(branchEntries, "m3"), signal: new AbortController().signal },
      { cwd: process.cwd(), model: { provider: "anthropic", api: "messages", id: "t" }, sessionManager: { getSessionId: () => sessionId, getEntries: () => branchEntries }, ui: { notify: vi.fn() } });
  };
  const scope = (sessionId: string) => ({ sessionId, cwd: canonicalMonitorCwd(process.cwd()) });

  it("appends a [Background Jobs] section for live shell/subagent/fork jobs and proves it as a jobs span", () => {
    const sid = "bj-live";
    const revokes = [
      publishCapability("shell_job", scope(sid), 1, () => ({}), () => true, undefined, () => [brief("shell_job", "SH-LIVE")]),
      publishCapability("subagent_job", scope(sid), 1, () => ({}), () => true, undefined, () => [brief("subagent_job", "SA-LIVE")]),
      publishCapability("fork_job", scope(sid), 1, () => ({}), () => true, undefined, () => [brief("fork_job", "FK-LIVE", "blocked")]),
    ];
    try {
      const result = run(sid);
      const summary: string = result.compaction.summary;
      expect(summary).toContain("[Background Jobs");
      for (const line of ["- Shell Job: SH-LIVE (running)", "- Subagent Job: SA-LIVE (running)", "- Fork Job: FK-LIVE (blocked)"]) expect(summary).toContain(line);
      const proof = result.compaction.details["blackhole.generatedSpans"].summary;
      expect(proof.spans.map((s: any) => s.kind)).toContain("jobs");
      expect(validGeneratedProof(summary, proof)).toBe(true);
    } finally { revokes.forEach(r => r()); }
  });
  it("adds nothing when no job is live, and ignores jobs of another session", () => {
    const sid = "bj-none";
    const revoke = publishCapability("shell_job", scope("someone-else"), 1, () => ({}), () => true, undefined, () => [brief("shell_job", "FOREIGN")]);
    try {
      const summary: string = run(sid).compaction.summary;
      expect(summary).not.toContain("[Background Jobs");
      expect(summary).not.toContain("FOREIGN");
    } finally { revoke(); }
  });
  it("a throwing provider never blocks the compaction", () => {
    const sid = "bj-throw";
    const revoke = publishCapability("shell_job", scope(sid), 1, () => ({}), () => true, undefined, () => { throw new Error("boom"); });
    try { expect(run(sid).compaction.summary).toContain("[Session Goal]"); } finally { revoke(); }
  });
  it("append mode keeps the section in the trailing summary with a proven jobs span", () => {
    const sid = "bj-append";
    const revoke = publishCapability("fork_job", scope(sid), 1, () => ({}), () => true, undefined, () => [brief("fork_job", "FK-APPEND")]);
    try {
      const result = run(sid, "append");
      expect(JSON.stringify(result.compaction)).toContain("FK-APPEND");
      const spans = result.compaction.details["blackhole.generatedSpans"];
      const kinds = [...(spans.summary?.spans ?? []), ...(spans.trailing?.spans ?? [])].map((s: any) => s.kind);
      expect(kinds).toContain("jobs");
    } finally { revoke(); }
  });
});
