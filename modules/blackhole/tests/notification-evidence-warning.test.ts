import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectNotification, notificationEvidenceSummary, notificationEvidenceMetadata, EVIDENCE_METADATA_KEY } from "../src/core/notification-evidence.js";
import { vccRecall } from "../src/tools/recall.js";
import { registerVccRecallCommand } from "../src/commands/vcc-recall.js";

const receipt = (value = true) => ({ taskId: "T", queryId: "Q", status: "failed", cleanupPending: false, usageUnknown: false, lateUsage: value, snapshotUnavailable: value });
const notification = (nested: boolean, value = true) => {
  const q = receipt(value);
  const details = nested ? { kind: "task_result", jobId: "J", status: "failed", tasks: [{ taskId: "T", status: "failed", queries: [q] }] } : { kind: "query_result", jobId: "J", interaction: q };
  return { type: "custom_message", id: "notice", customType: "subagent_background", details,
    content: JSON.stringify({ kind: "query_result", jobId: "J", queryId: "Q", status: "completed", cleanupPending: true, lateUsage: !value, snapshotUnavailable: !value, tasks: [{ taskId: "T", status: "completed", queries: [{ ...q, status: "completed", lateUsage: !value, snapshotUnavailable: !value }] }] }) };
};
async function withFile(lines: string[], fn: (file: string) => any) {
  const dir = mkdtempSync(join(tmpdir(), "blackhole-warning-"));
  try { const file = join(dir, "session.jsonl"); writeFileSync(file, lines.join("\n")); return await fn(file); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const context = (file: string, entries: any[], branch = entries) => ({ sessionManager: { getSessionFile: () => file, getBranch: () => branch, getEntries: () => entries } });

describe("follow-up warning regressions", () => {
  it.each([false, true])("R1: details-only late diagnostics in nested=%s query shape", async nested => {
    for (const value of [true, false]) {
      const e = notification(nested, value), p = projectNotification(e)!;
      for (const root of [p.data, p.structural]) {
        const q = nested ? root.tasks[0].queries[0] : root;
        expect(q.status).toBe("failed"); expect(q.cleanupPending).toBe(false);
        expect(q.lateUsage).toBe(value); expect(q.snapshotUnavailable).toBe(value);
      }
      const summary = notificationEvidenceSummary([e], "");
      const compaction = { type: "compaction", id: "c", summary, firstKeptEntryId: "", details: { compactor: "blackhole", version: 1, [EVIDENCE_METADATA_KEY]: notificationEvidenceMetadata(summary, summary) } };
      const second = notificationEvidenceSummary([e, compaction, { type: "message", id: "next" }], "next", summary);
      for (const text of [summary, second]) { expect(text).toContain(`"lateUsage":${value}`); expect(text).toContain(`"snapshotUnavailable":${value}`); expect(text).not.toContain('"status":"completed"'); }
      await withFile([JSON.stringify(e)], async file => {
        const ctx = context(file, [e]), result = await vccRecall({ query: "e:notice" }, ctx);
        expect(result.content[0].text).toContain(`"lateUsage":${value}`);
        expect(result.content[0].text).toContain(`"snapshotUnavailable":${value}`);
        expect(result.content[0].text).not.toContain('"status":"completed"');
        const sent: any[] = []; let command: any;
        registerVccRecallCommand({ registerCommand: (_: string, c: any) => { command = c; }, sendMessage: (m: any) => sent.push(m) } as any);
        await command.handler("e:notice", ctx); expect(sent[0].content).toBe(result.content[0].text);
      });
    }
    const without = notification(nested, false) as any;
    const q = nested ? without.details.tasks[0].queries[0] : without.details.interaction;
    delete q.lateUsage; delete q.snapshotUnavailable;
    const p = projectNotification(without)!;
    const projected = nested ? p.data.tasks[0].queries[0] : p.data;
    expect(projected).not.toHaveProperty("lateUsage"); expect(projected).not.toHaveProperty("snapshotUnavailable");
  });
  it.each(["missing", "excluded", "ambiguous", "malformed", "uninspected"])("R2: bounded no-match envelope for %s", async scenario => {
    const e = notification(false), entries = scenario === "ambiguous" ? [e, e] : scenario === "excluded" ? [e] : [];
    const lines = scenario === "malformed" ? ['{"type":"custom_message",'] : scenario === "uninspected" ? ["x".repeat(70000)] : entries.map(e => JSON.stringify(e));
    const branch = scenario === "excluded" ? [{ type: "custom", id: "other" }] : entries;
    await withFile(lines, async file => {
      for (const budget of [1, 50, 200, 0]) {
        const result = await vccRecall({ query: scenario === "missing" || scenario === "malformed" ? "e:missing" : "e:notice" }, context(file, entries, branch), budget) as any;
        const text = result.content[0].text;
        if (budget) expect(text.length).toBeLessThanOrEqual(budget);
        else { expect(text).toContain("No matches"); expect(text).toContain("selected session scope"); if (scenario === "malformed") expect(text).toContain("malformed_json"); }
        expect(text).not.toContain("[Evidence body]");
        const diagnostic = result.details.notificationEvidence;
        expect(diagnostic.reason).toBe("unavailable_in_selected_inspection"); expect(diagnostic.deliveredChars).toBe(0);
        expect(diagnostic.possibilities).toEqual(["missing", "excluded", "ambiguous", "uninspected"]);
        expect(diagnostic.outcomeKnown).toBe(false);
        expect(diagnostic).not.toHaveProperty("offset"); expect(diagnostic).not.toHaveProperty("nextPage");
        if (scenario === "malformed") { expect(diagnostic.inspectionIncomplete).toBe(true); expect(diagnostic.inspectionReasons).toContain("malformed_json"); }
        if (scenario === "uninspected") { expect(diagnostic.inspectionIncomplete).toBe(true); expect(diagnostic.inspectionReasons).toContain("line_limit"); if (!budget) expect(text).toContain("line_limit"); }
      }
    });
  });
});
