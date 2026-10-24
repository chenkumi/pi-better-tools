/**
 * Local adaptation: tool failure messages must tell the model which parameter or item is wrong,
 * which rule was violated, and how to fix it. Host-shaped calls only (tool.execute / agent tools).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runObserver } from "../src/om/agents/observer/agent.js";
import { runReflector } from "../src/om/agents/reflector/agent.js";
import { registerRecallTool, vccRecall } from "../src/tools/recall.js";
import { observation } from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
  return ((prompts: any[], context: any, config: any) => ({
    async *[Symbol.asyncIterator]() {},
    result: async () => {
      await handler(prompts, context, config);
      return {};
    },
  })) as any;
}

describe("internal tool receipts identify rejected items", () => {
  it("record_observations names the rejected observation index and the allowed ids", async () => {
    let text = "";
    const loop = fakeAgentLoop(async (_p, context) => {
      const r = await context.tools[0].execute("t", {
        observations: [
          { content: "Good", relevance: "medium", sourceEntryIds: ["entry-a"] },
          { content: "Bad", relevance: "medium", sourceEntryIds: ["nope"] },
        ],
        complete: false,
      });
      text = r.content[0].text;
    });
    await runObserver({
      model: {} as any, apiKey: "k", priorReflections: [], priorObservations: [],
      chunk: "[Source entry id: entry-a]\nhello", allowedSourceEntryIds: ["entry-a"],
      sourceEntryTimestamps: { "entry-a": "2026-05-02 10:30" }, agentLoop: loop,
    });
    expect(text).toContain("observations[1]");
    expect(text).toContain('"nope"');
    expect(text).toMatch(/entry ids? (from|listed in) the chunk/i);
  });

  it("record_reflections names the rejected reflection index and the cause", async () => {
    let text = "";
    const loop = fakeAgentLoop(async (_p, context) => {
      const r = await context.tools[0].execute("t", {
        reflections: [
          { content: "Bad support", supportingObservationIds: ["missing"] },
          { content: "Two\nlines", supportingObservationIds: ["aaaaaaaaaaaa"] },
        ],
        complete: false,
      });
      text = r.content[0].text;
    });
    await runReflector({
      model: {} as any, apiKey: "k", reflections: [],
      observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")], agentLoop: loop,
    });
    expect(text).toContain("reflections[0]");
    expect(text).toContain('"missing"');
    expect(text).toContain("reflections[1]");
    expect(text).toMatch(/single line|one line/i);
  });
});

describe("recall and drill-down failures", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "bh-errmsg-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(file, JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hello world" } }) + "\n", "utf8");
    let tool: any;
    registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any);
    const call = (params: Record<string, unknown>, sessionFile: string | null = file) =>
      tool.execute("c", params, undefined, undefined, {
        sessionManager: { getSessionFile: () => sessionFile ?? undefined, getBranch: () => [{ id: "m1" }], getEntries: () => [{ id: "m1" }] },
      }).then((r: any) => r.content[0].text as string);
    return { dir, call };
  };

  it("rejects a non-integer or non-positive page with the parameter, value and fix", async () => {
    const { dir, call } = setup();
    try {
      for (const page of [0, -2, 1.5]) {
        const text = await call({ query: "hello", page });
        expect(text).toContain('Parameter "page"');
        expect(text).toContain(String(page));
        expect(text).toMatch(/positive integer|integer >= 1/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("says page is ignored when no query or expand is given", async () => {
    const { dir, call } = setup();
    try {
      const text = await call({ page: 3 });
      expect(text).toContain('"page" was ignored');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("explains an unpersisted session and how to proceed", async () => {
    const { dir, call } = setup();
    try {
      const text = await call({ query: "x" }, null);
      expect(text).toContain("session is not persisted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("drill-down not-found and no-file messages state the fix", async () => {
    const { dir, call } = setup();
    try {
      const missing = await call({ query: "#99:file", scope: "all" });
      expect(missing).toContain("#99");
      expect(missing).toMatch(/query without #N|recall results/i);
      const none = await call({ query: "#0:auth.ts", scope: "all" });
      expect(none).toContain('No file content found in entry #0 for "auth.ts"');
      expect(none).toMatch(/#0:file|expand/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("evidence budget failure never names a settings key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bh-errmsg-"));
    try {
      const e = { type: "custom_message", id: "x".repeat(128), customType: "scheduled_prompt", details: { jobId: "J", mode: "subagent_done", output: "0123456789".repeat(500) } };
      const file = join(dir, "session.jsonl");
      writeFileSync(file, JSON.stringify(e), "utf8");
      const ctx = { sessionManager: { getSessionFile: () => file, getBranch: () => [e] } };
      const result = (await vccRecall({ query: `e:${e.id}` }, ctx, 130)) as any;
      const text = result.content[0].text as string;
      expect(result.isError).toBe(true);
      expect(result.details.notificationEvidence.reason).toBe("budget_insufficient");
      expect(text).toContain("Budget insufficient");
      expect(text).toMatch(/recall response size limit/);
      expect(text).not.toMatch(/recallResponseMaxChars|PI_BLACKHOLE|settings/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
