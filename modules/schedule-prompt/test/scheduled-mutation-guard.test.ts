import { describe, expect, it } from "vitest";
import { createPromptTool } from "../src/tool.js";

// A turn started by a scheduled run: the notify marker of a finished child after the latest user message.
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistant = () => ({ type: "message", message: { role: "assistant", content: [] } });
const scheduledTurn = () => [user("x"), assistant(), { type: "custom_message", customType: "scheduled_prompt", details: { notify: true, mode: "subagent_done" } }];

function harness(entries: any[]) {
  const touched: string[] = [];
  const job = { id: "victim", name: "victim", type: "cron", schedule: "*/5 * * * *", prompt: "original", enabled: true, scope: "session", createdAt: "2026-01-01T00:00:00Z" };
  const storage = new Proxy({ getJob: () => job, getAllJobs: () => [job] } as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      touched.push(prop);
      return () => { throw new Error(`storage.${prop} must not be reached`); };
    },
  });
  const scheduler = new Proxy({} as Record<string, unknown>, { get: (_t, prop: string) => { touched.push(`scheduler.${prop}`); return () => undefined; } });
  const tool = createPromptTool(() => storage as any, () => scheduler as any);
  const ctx = { sessionManager: { getBranch: () => entries, getSessionId: () => "s" } } as any;
  const run = (params: Record<string, unknown>) => tool.execute("c", params as any, undefined as any, undefined as any, ctx) as Promise<any>;
  return { run, touched };
}

describe("a scheduled turn may only read the schedule", () => {
  for (const params of [
    { action: "add", schedule: "+10s", prompt: "p" },
    { action: "update", jobId: "victim", prompt: "injected-by-scheduled-run" },
    { action: "remove", jobId: "victim" },
    { action: "enable", jobId: "victim" },
    { action: "disable", jobId: "victim" },
    { action: "cleanup" },
  ]) {
    it(`rejects ${params.action} as an isError result without touching storage or the scheduler`, async () => {
      const { run, touched } = harness(scheduledTurn());
      const result = await run(params);
      expect(result.isError).toBe(true);
      expect(result.details.error).toMatch(/scheduled prompt execution/i);
      expect(touched).toEqual([]);
    });
  }

  it("still allows list inside a scheduled turn", async () => {
    const { run } = harness(scheduledTurn());
    const result = await run({ action: "list" });
    expect(result.isError).toBeUndefined();
  });

  it("does not restrict an ordinary user turn", async () => {
    const { run } = harness([user("please remove it"), assistant()]);
    const result = await run({ action: "remove", jobId: "victim" });
    expect(result.details.error ?? "").not.toMatch(/scheduled prompt execution/i);
  });
});
