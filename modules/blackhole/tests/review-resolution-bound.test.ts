import { afterEach, expect, it, vi } from "vitest";
import { Runtime } from "../src/om/runtime.js";
import { makeModelResolver } from "../src/om/consolidation.js";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
afterEach(() => vi.useRealTimers());
for (const boundary of ["candidate", "session", "endpoint", "recheck"] as const) {
  for (const revoke of ["deadline", "branch", "dispose"] as const) {
    it(`R17 ${boundary} stalled resolution releases tracked gate on ${revoke}, rejects late effects`, async () => {
      vi.useFakeTimers();
      const runtime = new Runtime();
      runtime.startSession("isolated-review-session");
      runtime.config.workerAttemptTimeoutMs = revoke === "deadline" ? 100 : 0;
      runtime.config.sessionFallback = boundary === "session";
      if (boundary !== "session") runtime.config.observerModel = { provider: "review-fake", id: "model", cooldownHours: 0 };
      const waiting = deferred<any>(); const entered = deferred<void>();
      const stall = () => { entered.resolve(); return waiting.promise; };
      const endpoint = vi.fn(boundary === "endpoint" ? stall : async () => undefined);
      const model = { provider: "review-fake", id: "model", contextWindow: 100000 };
      const registry = {
        find: () => model,
        getApiKeyAndHeaders: boundary === "candidate" || boundary === "session" ? stall : async () => boundary === "recheck" ? { ok: true } : { ok: true, apiKey: "fixture-only" },
        hasConfiguredAuth: () => boundary !== "recheck",
        getProviderAuth: endpoint,
        refresh: boundary === "recheck" ? stall : async () => {},
      };
      const ctx: any = { hasUI: false, model, modelRegistry: registry, sessionManager: { getSessionId: () => "isolated-review-session", getBranch: () => [] } };
      const generation = runtime.captureGeneration("isolated-review-session");
      const resolver = makeModelResolver(runtime, ctx, generation);
      const effects = vi.fn();
      let settled = false;
      const work = runtime.launchConsolidationTask(ctx, async () => {
        runtime.consolidationPhase = "observer";
        const resolved = await resolver("observer");
        if (resolved) effects(); // Stand-in for the worker start/append boundary.
      }).then(() => { settled = true; });
      try {
        await entered.promise;
        expect(runtime.consolidationInFlight).toBe(true);
        if (revoke === "deadline") await vi.advanceTimersByTimeAsync(100);
        if (revoke === "branch") runtime.advanceBranchEpoch();
        if (revoke === "dispose") runtime.dispose();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(settled).toBe(true);
        expect(runtime.consolidationInFlight).toBe(false);
        expect(runtime.consolidationPromise).toBeNull();
        expect(effects).not.toHaveBeenCalled();
        // A provider ignoring cancellation may still settle later. It cannot
        // invoke the next endpoint resolver or return a usable late model.
        if (boundary === "endpoint") waiting.reject(Error("late provider rejection"));
        else waiting.resolve({ ok: true, apiKey: "fixture-only" });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(effects).not.toHaveBeenCalled();
        if (boundary === "candidate" || boundary === "session") expect(endpoint).not.toHaveBeenCalled();
      } finally {
        runtime.dispose();
        waiting.resolve({ ok: false });
        await vi.advanceTimersByTimeAsync(5000);
        await work;
      }
    });
  }
}
