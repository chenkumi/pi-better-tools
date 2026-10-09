import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLastAssistantError, runSubagentOnce, SUBAGENT_TIMEOUT_MS } from "../src/subagent.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  // biome-ignore lint/complexity/useArrowFunction: used as a constructor mock
  DefaultResourceLoader: vi.fn(function () {
    return { reload: vi.fn().mockResolvedValue(undefined) };
  }),
  getAgentDir: vi.fn(() => "/tmp/agent-dir"),
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { create: vi.fn(() => ({})) },
}));

import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const mockCreate = vi.mocked(createAgentSession);
const mockLoader = vi.mocked(DefaultResourceLoader);
const MODEL = { id: "gpt-4o", name: "GPT-4o", provider: "openai" };
const ctx = { cwd: "/tmp", modelRegistry: { find: () => MODEL, getAvailable: () => [MODEL] } } as any;

function session(overrides: Record<string, unknown> = {}) {
  return { abort: vi.fn(), dispose: vi.fn(), subscribe: vi.fn(() => vi.fn()), prompt: vi.fn().mockResolvedValue(undefined), messages: [], bindExtensions: vi.fn(), ...overrides };
}

describe("runSubagentOnce stability", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockLoader.mockClear();
  });

  it("disposes the session after success and failure, and survives a creation-time error", async () => {
    const ok = session();
    mockCreate.mockResolvedValueOnce({ session: ok } as any);
    await runSubagentOnce(ctx, "p", MODEL.id);
    expect(ok.dispose).toHaveBeenCalledTimes(1);

    const bad = session({ prompt: vi.fn().mockRejectedValue(new Error("boom")) });
    mockCreate.mockResolvedValueOnce({ session: bad } as any);
    expect(await runSubagentOnce(ctx, "p", MODEL.id)).toEqual({ ok: false, error: "boom" });
    expect(bad.dispose).toHaveBeenCalledTimes(1);

    mockCreate.mockRejectedValueOnce(new Error("no session")); // nothing to dispose; must not throw
    expect(await runSubagentOnce(ctx, "p", MODEL.id)).toEqual({ ok: false, error: "no session" });
  });

  it("reports a provider error stop as a failure, not an empty success", async () => {
    const failed = session({ messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited" }] });
    mockCreate.mockResolvedValueOnce({ session: failed } as any);
    expect(await runSubagentOnce(ctx, "p", MODEL.id)).toEqual({ ok: false, error: "429 rate limited" });
    expect(getLastAssistantError({ messages: [{ role: "assistant", stopReason: "stop" }] } as any)).toBeUndefined();
  });

  it("aborts and fails a run that exceeds the timeout", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const hung = session({ prompt: vi.fn(() => new Promise<void>((r) => (release = r))) });
      hung.abort.mockImplementation(() => release());
      mockCreate.mockResolvedValueOnce({ session: hung } as any);
      const result = runSubagentOnce(ctx, "p", MODEL.id);
      await vi.advanceTimersByTimeAsync(SUBAGENT_TIMEOUT_MS + 1);
      expect(await result).toMatchObject({ ok: false, error: expect.stringContaining("Timed out") });
      expect(hung.abort).toHaveBeenCalled();
      expect(hung.dispose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never loads this extension into the child, with or without a name filter", async () => {
    const self = resolve(__dirname, "../src/index.ts");
    const others = [{ path: "/x/pi-web/index.ts" }, { path: "/x/pi-other/index.ts" }];
    for (const extensions of [true, ["pi-"] as string[]]) {
      mockCreate.mockResolvedValueOnce({ session: session() } as any);
      await runSubagentOnce(ctx, "p", MODEL.id, undefined, { extensions });
      const { extensionsOverride } = mockLoader.mock.calls.at(-1)![0] as any;
      const kept = extensionsOverride({ extensions: [{ path: self }, { path: "/y/other-ext/index.ts", resolvedPath: self }, ...others] }).extensions;
      expect(kept).toEqual(others);
    }
  });
});
