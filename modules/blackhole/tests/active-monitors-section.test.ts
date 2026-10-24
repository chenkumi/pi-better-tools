import { describe, expect, it, vi } from "vitest";
import { renderActiveMonitors } from "../src/core/active-monitors-section.js";
import { composeGeneratedParts, stripGeneratedSpans, validGeneratedProof } from "../src/core/generated-summary-spans.js";
import { compile } from "../src/core/summarize.js";
import { registerBeforeCompactHook } from "../src/hooks/before-compact.js";
import { publishActiveMonitorBriefs, canonicalMonitorCwd } from "../../shell-tools/src/monitor-capability.js";
import { fixtureNativePreparation } from "./fixtures/native-preparation.js";

const brief = (overrides: any = {}) => ({ monitorId: "01HZZZZZZZZZZZZZZZZZZZZZZZ", source: "file", state: "running", target: "src/app.ts", remainingMs: 240000, ...overrides });

describe("renderActiveMonitors", () => {
  it("renders nothing when no monitor is live and nothing was lost", () => {
    expect(renderActiveMonitors([], false)).toBe("");
  });
  it("lists source, target, state, remaining lifetime, id and label", () => {
    const text = renderActiveMonitors([
      brief({ label: "watch schema" }),
      brief({ monitorId: "01HYYYYYYYYYYYYYYYYYYYYYYY", source: "command", target: "[command withheld]", remainingMs: 45000 }),
      brief({ monitorId: "01HXXXXXXXXXXXXXXXXXXXXXXX", source: "websocket", target: "wss://example.org/[path withheld]", state: "starting", remainingMs: 1500000 }),
    ], false);
    expect(text.split("\n")[0]).toMatch(/^\[Active Monitors — live at compaction time/);
    expect(text).toContain("- File: src/app.ts (running, 4m left) — id 01HZZZZZZZZZZZZZZZZZZZZZZZ — label: watch schema");
    expect(text).toContain("- Command: [command withheld] (running, 45s left)");
    expect(text).toContain("- WebSocket: wss://example.org/[path withheld] (starting, 25m left)");
    expect(text).toMatch(/monitor_status/);
  });
  it("strips control characters and never lets a target break the block", () => {
    const text: string = renderActiveMonitors([brief({ target: "src/a\nb\u001b[31m.ts", label: "x\u202ey" })], false);
    expect(text).not.toMatch(/[\u001b\u202e]/);
    expect(text.split("\n").filter(line => line.startsWith("- File:"))).toHaveLength(1);
  });
  it("drops unknown sources and malformed ids/states, and marks the list partial", () => {
    const text = renderActiveMonitors([brief({ source: "socket" }), brief({ monitorId: "bad\nid" }), brief({ state: "Running" }), brief()], false);
    expect(text.match(/^- File:/gm)).toHaveLength(1);
    expect(text).toMatch(/partial/i);
  });
  it("caps the listing at 16 rows and says so", () => {
    const rows = Array.from({ length: 20 }, (_, i) => brief({ monitorId: `01H${String(i).padStart(23, "0")}` }));
    const text = renderActiveMonitors(rows, false);
    expect(text.match(/^- File:/gm)).toHaveLength(16);
    expect(text).toMatch(/partial/i);
  });
  it("reports unreadable input as partial instead of pretending nothing is running", () => {
    expect(renderActiveMonitors([], true)).toMatch(/partial/i);
  });
});

describe("generated 'monitors' span", () => {
  it("is proven by composition and removed as a generated span", () => {
    const section = renderActiveMonitors([brief()], false);
    const composed = composeGeneratedParts([{ text: "[Session Goal]\n- x" }, { text: section, kind: "monitors" }, { text: "tail", kind: "om" }]);
    expect(validGeneratedProof(composed.text, composed.proof)).toBe(true);
    expect(composed.proof.spans.map(s => s.kind)).toEqual(["monitors", "om"]);
    const stripped = stripGeneratedSpans(composed.text, composed.proof);
    expect(stripped).not.toContain("src/app.ts");
    expect(stripped).toContain("[Session Goal]");
  });
  it("a later compile never carries a proven previous monitors section forward", () => {
    const section = renderActiveMonitors([brief({ target: "STALE-TARGET.ts" })], false);
    const composed = composeGeneratedParts([{ text: "[Session Goal]\n- Fix auth" }, { text: section, kind: "monitors" }]);
    const next = compile({ messages: [{ role: "user", content: "next step" }] as any, previousSummary: composed.text, previousGeneratedSpans: composed.proof, fileOps: { readFiles: [], modifiedFiles: [] }, cwd: process.cwd() } as any);
    expect(next).not.toContain("STALE-TARGET.ts");
    expect(next).not.toContain("[Active Monitors");
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

  it("appends an [Active Monitors] section for live monitors and proves it as a monitors span", () => {
    const sid = "am-live";
    const revoke = publishActiveMonitorBriefs(scope(sid), () => [brief({ label: "watch schema" }), brief({ monitorId: "01HAAAAAAAAAAAAAAAAAAAAAAA", source: "shell_job", target: "SH-LIVE" })]);
    try {
      const result = run(sid);
      const summary: string = result.compaction.summary;
      expect(summary).toContain("[Active Monitors");
      expect(summary).toContain("- File: src/app.ts (running, 4m left)");
      expect(summary).toContain("label: watch schema");
      expect(summary).toContain("- Shell Job: SH-LIVE (running, 4m left)");
      const proof = result.compaction.details["blackhole.generatedSpans"].summary;
      expect(proof.spans.map((s: any) => s.kind)).toContain("monitors");
      expect(validGeneratedProof(summary, proof)).toBe(true);
    } finally { revoke(); }
  });
  it("adds nothing when no monitor is live, and ignores monitors of another session", () => {
    const sid = "am-none";
    const revoke = publishActiveMonitorBriefs(scope("someone-else"), () => [brief({ target: "FOREIGN.ts" })]);
    try {
      const summary: string = run(sid).compaction.summary;
      expect(summary).not.toContain("[Active Monitors");
      expect(summary).not.toContain("FOREIGN.ts");
    } finally { revoke(); }
  });
  it("a throwing reader never blocks the compaction", () => {
    const sid = "am-throw";
    const revoke = publishActiveMonitorBriefs(scope(sid), () => { throw new Error("boom"); });
    try {
      const summary: string = run(sid).compaction.summary;
      expect(summary).toContain("[Session Goal]");
      expect(summary).toMatch(/partial/i);
    } finally { revoke(); }
  });
  it("append mode keeps the section in the trailing summary with a proven monitors span", () => {
    const sid = "am-append";
    const revoke = publishActiveMonitorBriefs(scope(sid), () => [brief({ target: "APPEND-TARGET.ts" })]);
    try {
      const result = run(sid, "append");
      expect(JSON.stringify(result.compaction)).toContain("APPEND-TARGET.ts");
      const spans = result.compaction.details["blackhole.generatedSpans"];
      const kinds = [...(spans.summary?.spans ?? []), ...(spans.trailing?.spans ?? [])].map((s: any) => s.kind);
      expect(kinds).toContain("monitors");
    } finally { revoke(); }
  });
});
