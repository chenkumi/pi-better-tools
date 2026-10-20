import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { Runtime } from "../src/om/runtime.js";
import { registerConsolidationTrigger } from "../src/om/consolidation.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(mode: "ignore-abort" | "honor-abort", timeoutMs?: number) {
  const runtime = new Runtime();
  runtime.configLoaded = true; // skip reading user config; defaults only
  runtime.config.observeAfterTokens = 1;
  runtime.config.reflectAfterTokens = 1;
  if (timeoutMs !== undefined) runtime.config.workerAttemptTimeoutMs = timeoutMs;
  runtime.loadCursorsFromPending = vi.fn();
  runtime.scheduleCursorFlush = vi.fn();
  runtime.startSession("blk01-session");
  const model = { provider: "fake", id: "m", api: "openai-completions", contextWindow: 1_000_000 };
  runtime.resolveModel = vi.fn(async () => ({
    ok: true as const, source: "candidate" as const,
    candidateConfig: { provider: "fake", id: "m" }, model, apiKey: "fixture-only",
  }));
  const entries: any[] = [
    { type: "compaction", id: "c0", summary: "prior", firstKeptEntryId: "m1" },
    { type: "message", id: "m1", message: { role: "user", content: "new source text ".repeat(200) } },
  ];
  const handlers = new Map<string, Function>();
  const pi = { on: (n: string, h: Function) => handlers.set(n, h), appendEntry: () => {} } as any;
  const streamSimple = vi.fn((_m: any, _c: any, opts: any) => {
    // Fake provider: returns a stream that never produces events.
    const never = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; }, result: () => new Promise(() => {}) };
    if (mode === "honor-abort") {
      const st = createAssistantMessageEventStream();
      opts.signal?.addEventListener("abort", () => {
        const message: any = { role: "assistant", content: [], api: "openai-completions", provider: "fake", model: "m",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "aborted", errorMessage: "aborted", timestamp: Date.now() };
        st.push({ type: "error", reason: "aborted", error: message });
        st.end(message);
      }, { once: true });
      return st;
    }
    return never;
  });
  const ctx: any = {
    cwd: process.cwd(), hasUI: false, model,
    modelRegistry: { streamSimple },
    sessionManager: { getBranch: () => entries, getSessionId: () => "blk01-session", getLeafId: () => "m1" },
  };
  registerConsolidationTrigger(pi, runtime);
  return { runtime, handlers, ctx, streamSimple };
}

async function waitFor(fn: () => boolean, ms = 5000) {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("waitFor timeout"); await sleep(20); }
}

describe("consolidation abort releases in-flight flag (BLK-01)", () => {
  it("default config: workerAttemptTimeoutMs is undefined", () => {
    expect(new Runtime().config.workerAttemptTimeoutMs).toBeUndefined();
  });

  for (const trigger of ["session_tree", "session_start(new id)"] as const) {
    it(`abort-ignoring provider, default config, abort via ${trigger}: flag released, next consolidation starts`, async () => {
      const f = setup("ignore-abort");
      f.handlers.get("turn_end")!({}, f.ctx);
      await waitFor(() => f.streamSimple.mock.calls.length === 1);
      expect(f.runtime.consolidationInFlight).toBe(true);
      const sig = f.streamSimple.mock.calls[0][2].signal as AbortSignal | undefined;
      // abort the lifecycle
      if (trigger === "session_tree") f.handlers.get("session_tree")!({}, f.ctx);
      else f.handlers.get("session_start")!({}, { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "other" } });
      expect(sig?.aborted).toBe(true);
      await waitFor(() => f.runtime.consolidationInFlight === false);
      // a new turn on the (restored) session tries to start consolidation again
      f.runtime.startSession("blk01-session");
      const before = (f.runtime.resolveModel as any).mock.calls.length;
      f.handlers.get("turn_end")!({}, f.ctx);
      await waitFor(() => f.streamSimple.mock.calls.length === 2);
      expect((f.runtime.resolveModel as any).mock.calls.length).toBeGreaterThan(before);
    });
  }

  it("CONTROL honor-abort provider: flag released, 2nd consolidation starts", async () => {
    const f = setup("honor-abort");
    f.handlers.get("turn_end")!({}, f.ctx);
    await waitFor(() => f.streamSimple.mock.calls.length === 1);
    f.handlers.get("session_tree")!({}, f.ctx);
    await waitFor(() => f.runtime.consolidationInFlight === false);
    f.handlers.get("turn_end")!({}, f.ctx);
    await waitFor(() => f.streamSimple.mock.calls.length === 2);
  });

  it("CONTROL abort-ignoring provider with workerAttemptTimeoutMs=200: flag released after abort", async () => {
    const f = setup("ignore-abort", 200);
    f.handlers.get("turn_end")!({}, f.ctx);
    await waitFor(() => f.streamSimple.mock.calls.length === 1);
    f.handlers.get("session_tree")!({}, f.ctx);
    await waitFor(() => f.runtime.consolidationInFlight === false);
  });
});
