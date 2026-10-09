/**
 * Pi-owned wiring: the factory must neither probe/install a private adapter
 * nor register Blackhole threshold/idle triggers.
 *
 * Every sibling module of `index.ts` is mocked so this stays a wiring test —
 * no Pi host, no config file, no network.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";

const installMock = vi.fn();
const registerCompactionTriggerMock = vi.fn();
const registerPreCompactionOutputMock = vi.fn();

vi.mock("../src/core/settings", () => ({ scaffoldSettings: vi.fn() }));
vi.mock("../src/hooks/before-compact", () => ({ registerBeforeCompactHook: vi.fn() }));
vi.mock("../src/hooks/compact-failed", () => ({ registerCompactFailedHook: vi.fn() }));
vi.mock("../src/hooks/compaction-context", () => ({ registerCompactionContextHook: vi.fn() }));
vi.mock("../src/hooks/cosmetic-output", () => ({
  registerPreCompactionOutput: registerPreCompactionOutputMock,
}));
vi.mock("../src/commands/pi-vcc", () => ({ registerPiVccCommand: vi.fn() }));
vi.mock("../src/commands/memory", () => ({ registerMemoryCommand: vi.fn() }));
vi.mock("../src/commands/vcc-recall", () => ({ registerVccRecallCommand: vi.fn() }));
vi.mock("../src/commands/blackhole-export", () => ({ registerBlackholeExportCommand: vi.fn() }));
vi.mock("../src/om/consolidation", () => ({ registerConsolidationTrigger: vi.fn() }));
vi.mock("../src/tools/recall", () => ({ registerRecallTool: vi.fn() }));
vi.mock("../src/om/provider-stream", () => ({ captureRegisteredProviderStreams: vi.fn() }));
vi.mock("../src/om/inline-compaction", () => ({
  installHostInlineCompactionAdapter: installMock,
}));
vi.mock("../src/om/compaction-trigger", () => ({
  registerCompactionTrigger: registerCompactionTriggerMock,
}));
vi.mock("../src/om/runtime", () => ({
  Runtime: class Runtime {
    inlineCompactionAdapterStatus?: { supported: boolean; reason?: string };
  },
}));

function createPiMock(): ExtensionAPI {
  return createExtensionApiDouble();
}

describe("extension factory wiring", () => {
  beforeEach(() => {
    installMock.mockReset();
    registerCompactionTriggerMock.mockReset();
    registerPreCompactionOutputMock.mockReset();
  });

  it("registers display without private adapters, BH threshold scheduling, or idle polling", async () => {
    installMock.mockImplementation(() => { throw new Error("Private adapter installation forbidden"); });
    registerCompactionTriggerMock.mockImplementation(() => { throw new Error("BH automatic trigger forbidden"); });
    const { default: factory } = await import("../index");
    await factory(createPiMock());
    expect(installMock).not.toHaveBeenCalled();
    expect(registerCompactionTriggerMock).not.toHaveBeenCalled();
    expect(registerPreCompactionOutputMock).toHaveBeenCalledOnce();
  });
});
