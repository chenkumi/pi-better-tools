import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentOnce } from "../src/subagent.js";

// Pi 1.0 replaced `createAgentSession({ modelRegistry })` with `modelRuntime`.
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

import { createAgentSession } from "@earendil-works/pi-coding-agent";

const mockCreateAgentSession = vi.mocked(createAgentSession);
const MODEL = { id: "gpt-4o", name: "GPT-4o", provider: "openai" };

function makeCtx(registryExtra: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp",
    modelRegistry: { find: () => MODEL, getAvailable: () => [MODEL], ...registryExtra },
  } as any;
}

function fakeSession() {
  return { abort: vi.fn(), subscribe: vi.fn(() => vi.fn()), prompt: vi.fn().mockResolvedValue(undefined), messages: [] };
}

describe("runSubagentOnce — Pi 1.0 model runtime", () => {
  beforeEach(() => {
    mockCreateAgentSession.mockReset();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession() } as any);
  });

  it("reuses the host ModelRuntime behind the registry facade and never passes modelRegistry", async () => {
    const runtime = { getModel: vi.fn() };
    const result = await runSubagentOnce(makeCtx({ runtime }), "p", MODEL.id);
    expect(result.ok).toBe(true);
    const options = mockCreateAgentSession.mock.calls[0][0] as Record<string, unknown>;
    expect(options.modelRuntime).toBe(runtime);
    expect("modelRegistry" in options).toBe(false);
  });

  it("falls back to the SDK default runtime when the facade exposes none", async () => {
    await runSubagentOnce(makeCtx({ runtime: { unrelated: true } }), "p", MODEL.id);
    await runSubagentOnce(makeCtx(), "p", MODEL.id);
    for (const call of mockCreateAgentSession.mock.calls) {
      const options = call[0] as Record<string, unknown>;
      expect(options.modelRuntime).toBeUndefined();
      expect("modelRegistry" in options).toBe(false);
    }
  });
});
