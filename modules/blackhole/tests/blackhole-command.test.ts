/**
 * Tests for /blackhole command — compaction trigger, om-off/om-on, noAutoCompact flush.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const { testRoot } = vi.hoisted(() => {
  // Use require() to avoid import-hoisting issues with vi.mock
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  return {
    testRoot: join(tmpdir(), `pi-blackhole-cmd-test-${process.pid}-${Date.now()}`),
  };
});

// Mock the pi SDK before importing our module
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => join(testRoot, "agent"),
}));

// Mock the canonical config-flow so openSettings doesn't mount a real UI.
// The canonical flow renders a scope-selector + modal via ctx.ui.custom,
// which doesn't exist in these command-level tests.
vi.mock("../src/pi-base/settings/config-flow.js", () => ({
  openConfigFlow: vi.fn(async () => {}),
}));

import { registerPiVccCommand } from "../src/commands/pi-vcc.js";
import { flushManualPending, commitManualPending, pendingFingerprint } from "../src/om/manual-pending.js";
import { openConfigFlow } from "../src/pi-base/settings/config-flow.js";

function createMockEnvironment() {
  const compactCalls: Array<{
    customInstructions: string;
    onComplete: () => void;
    onError: (err: Error) => void;
  }> = [];
  const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];
  const notifyCalls: Array<{ msg: string; level: string }> = [];

  const pi = {
    registerCommand: vi.fn(
      (
        name: string,
        def: {
          handler: (args: unknown, ctx: unknown) => Promise<void>;
          getArgumentCompletions?: (prefix: string) => Array<{ value: string }>;
        },
      ) => {
        handlerMap.set(name, def.handler as any);
        if (def.getArgumentCompletions) {
          completionMap.set(name, def.getArgumentCompletions as any);
        }
      },
    ),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      appendEntryCalls.push({ customType, data });
    }),
  };

  const handlerMap = new Map<string, (args: unknown, ctx: unknown) => Promise<void>>();
  const completionMap = new Map<string, (prefix: string) => Array<{ value: string }>>();

  const runtime: any = {
    ensureConfig: vi.fn(),
    resetInfoGate: vi.fn(),
    tryEmitInfo: vi.fn((hasUI: boolean, ui: any, msg: string) => {
      if (!hasUI || !ui) return;
      try {
        ui.notify(msg, "info");
      } catch {
        /* stale ctx */
      }
    }),
    config: {
      memory: true,
      noAutoCompact: false,
    },
    compactionStats: null,
  };

  function makeHandlerArgs(overrides: Record<string, unknown> = {}) {
    const base = {
      cwd: testRoot,
      sessionManager: {
        getBranch: vi.fn(() => []),
        getSessionId: vi.fn(() => "test-session"),
      },
      compact: vi.fn(
        (opts: {
          customInstructions?: string;
          onComplete?: () => void;
          onError?: (err: Error) => void;
        }) => {
          compactCalls.push({
            customInstructions: opts.customInstructions ?? "",
            onComplete: opts.onComplete ?? (() => {}),
            onError: opts.onError ?? (() => {}),
          });
        },
      ),
      ui: {
        notify: vi.fn((msg: string, level: string) => {
          notifyCalls.push({ msg, level });
        }),
        custom: vi.fn(),
      },
      ...overrides,
    };
    return base as any;
  }

  return {
    pi,
    runtime,
    handlerMap,
    completionMap,
    makeHandlerArgs,
    compactCalls,
    appendEntryCalls,
    notifyCalls,
  };
}

describe("/blackhole command", () => {
  beforeEach(() => {
    mkdirSync(join(testRoot, "agent", "pi-blackhole"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("registers the blackhole command", () => {
    const { pi, runtime } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "blackhole",
      expect.objectContaining({
        description: expect.stringContaining("Manual compact"),
      }),
    );
  });

  it("surfaces a single 'settings' completion (with 'configure' alias matching)", () => {
    const { pi, runtime, completionMap } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    // Exactly one configuration entry — the settings handle, no separate
    // "configure" entry in the dropdown
    const completions = completionMap.get("blackhole")!("");
    const values = completions.map((c) => c.value);
    expect(values).toContain("settings");
    expect(values).not.toContain("configure");

    // Typing /blackhole config… surfaces the settings entry via its alias
    const configMatches = completionMap.get("blackhole")!("config").map((c) => c.value);
    expect(configMatches).toEqual(["settings"]);
  });

  it("refreshes runtime config after saving settings", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    vi.mocked(openConfigFlow).mockImplementationOnce(async (params: any) => {
      await params.save({ retainedToolOutputMaxTokens: 9_000 }, "global");
    });
    registerPiVccCommand(pi as any, runtime as any);

    await handlerMap.get("blackhole")!("settings", makeHandlerArgs());

    expect(runtime.config.retainedToolOutputMaxTokens).toBe(9_000);
  });

  it("calls ctx.compact with PI_VCC_COMPACT_INSTRUCTION", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const call = ctx.compact.mock.calls[0][0];
    expect(call.customInstructions).toBe("__pi_vcc__");
  });

  it("sends onComplete notification with stats when available", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    runtime.compactionStats = { summarized: 42, kept: 10, keptTokensEst: 5000 };
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onComplete();

    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("42 source entries");
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("5.0k tok");
  });

  it("sends onComplete fallback notification without stats", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onComplete();

    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Compacted with blackhole");
  });

  it("adds no toast when a compaction is cancelled", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    const before = notifyCalls.length;
    call.onError(new Error("Compaction cancelled"));

    // Pi owns the manual abort and renders cancellation; do not add a second toast.
    expect(notifyCalls.length).toBe(before);
  });

  it("handles onError for general failure", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onError(new Error("Model API error"));

    expect(notifyCalls[notifyCalls.length - 1].level).toBe("error");
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Compaction failed: Model API error");
  });

  it("/blackhole om-off disables memory and saves config", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    runtime.config.memory = true;

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("om-off", ctx);

    expect(runtime.config.memory).toBe(false);
    expect(notifyCalls[0].msg).toContain("Observational memory disabled");
  });

  it("/blackhole om-on enables memory and saves config", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    runtime.config.memory = false;

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("om-on", ctx);

    expect(runtime.config.memory).toBe(true);
    expect(notifyCalls[0].msg).toContain("Observational memory enabled");
  });

  it("preserves pending entries until native admission, then flushes the admitted manual summary", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    runtime.config.compaction = "manual";
    registerPiVccCommand(pi as any, runtime as any);

    // Write a pending state file — name pattern is <sessionId>-pending.json
    const pendingDir = join(testRoot, "agent", "pi-blackhole");
    const pendingFile = join(pendingDir, "test-session-pending.json");
    writeFileSync(
      pendingFile,
      JSON.stringify({
        // isPendingOMState checks for .observation/.reflection with coversUpToId
        observation: {
          coversUpToId: "raw-1",
          data: { observations: [{ id: "aaaaaaaaaaaa", content: "test obs" }] },
        },
        reflection: {
          coversUpToId: "raw-1",
          data: {
            reflections: [
              {
                id: "eeeeeeeeeeee",
                content: "test ref",
                supportingObservationIds: ["aaaaaaaaaaaa"],
              },
            ],
          },
        },
        observationBatches: [
          {
            data: {
              observations: [{ id: "aaaaaaaaaaaa", content: "test obs" }],
              coversUpToId: "raw-1",
            },
          },
        ],
        reflectionBatches: [
          {
            data: {
              reflections: [
                {
                  id: "eeeeeeeeeeee",
                  content: "test ref",
                  supportingObservationIds: ["aaaaaaaaaaaa"],
                },
              ],
              coversUpToId: "raw-1",
            },
          },
        ],
      }),
    );

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(existsSync(pendingFile)).toBe(true);
    expect(notifyCalls.some(n => n.msg.includes("pending entries flushed"))).toBe(false);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    // The admitted session_before_compact hook owns this flush, not the command.
    const snapshot = pendingFingerprint("test-session");
    expect(flushManualPending(pi as any, "test-session")).toBe(true);
    expect(existsSync(pendingFile)).toBe(true); // Admission is not persistence.
    expect(commitManualPending("test-session", snapshot)).toBe(true);
    expect(existsSync(pendingFile)).toBe(false);
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
  });
});

// Pi refuses ineligible branches before the summary hook. The command must never
// inspect private host preparation/settings; only native callback results are authoritative.
function createHostSession(options: {
  prepareCompaction?: (entries: unknown[], settings: unknown) => unknown;
  branchEntries?: unknown[];
}) {
  const getCompactionSettings = vi.fn(() => { throw new Error("Forbidden private settings preflight"); });
  const branchEntries = options.branchEntries ?? [];
  return { sessionManager: { getBranch: () => branchEntries, getSessionId: () => "test-session" }, getCompactionSettings, branchEntries };
}

function writePendingState(): string {
  const pendingFile = join(testRoot, "agent", "pi-blackhole", "test-session-pending.json");
  writeFileSync(
    pendingFile,
    JSON.stringify({
      observationBatches: [
        {
          data: { observations: [{ id: "aaaaaaaaaaaa", content: "test obs" }] },
          coversUpToId: "raw-1",
        },
      ],
      reflectionBatches: [
        {
          data: {
            reflections: [
              {
                id: "eeeeeeeeeeee",
                content: "test ref",
                supportingObservationIds: ["aaaaaaaaaaaa"],
              },
            ],
          },
          coversUpToId: "raw-1",
        },
      ],
    }),
  );
  return pendingFile;
}

describe("/blackhole manual-compaction eligibility", () => {
  beforeEach(() => {
    mkdirSync(join(testRoot, "agent", "pi-blackhole"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("reports native too-small refusal after requesting compaction", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({ prepareCompaction: () => undefined });

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager });
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledOnce();
    ctx.compact.mock.calls[0][0].onError(new Error("Nothing to compact (session too small)"));
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("nothing to compact");
    expect(notifyCalls[notifyCalls.length - 1].level).toBe("info");
  });

  it("reports an already-compacted branch distinctly from a too-small one", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({
      prepareCompaction: () => undefined,
      branchEntries: [{ id: "c1", type: "compaction", summary: "prior" }],
    });

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager });
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledOnce();
    ctx.compact.mock.calls[0][0].onError(new Error("Already compacted"));
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("already compacted");
  });

  it("does not flush pending observational memory when the branch is ineligible", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls, appendEntryCalls } =
      createMockEnvironment();
    runtime.config.compaction = "manual";
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({ prepareCompaction: () => undefined });
    const pendingFile = writePendingState();

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager });
    await handlerMap.get("blackhole")!("", ctx);

    expect(appendEntryCalls).toHaveLength(0);
    expect(existsSync(pendingFile)).toBe(true);
    expect(notifyCalls.some((n) => n.msg.includes("pending entries flushed"))).toBe(false);
  });

  it("compacts when the host reports the branch as eligible", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({
      prepareCompaction: () => ({ firstKeptEntryId: "e1" }),
    });

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager });
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("fails open when the host exposes no prepareCompaction", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({});

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager });
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("leaves effective model compaction settings entirely to the native request", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    const host = createHostSession({
      prepareCompaction: () => ({ firstKeptEntryId: "e1" }),
    });
    const model = { provider: "anthropic", id: "claude-sonnet-4" };

    const ctx = makeHandlerArgs({ sessionManager: host.sessionManager, model });
    await handlerMap.get("blackhole")!("", ctx);

    expect(host.getCompactionSettings).not.toHaveBeenCalled();
    expect(ctx.compact).toHaveBeenCalledOnce();
    expect(ctx.compact.mock.calls[0][0].customInstructions).toBe("__pi_vcc__");
  });

  it("loads config before the manual path reads it", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(runtime.ensureConfig).toHaveBeenCalledWith(ctx.cwd, expect.any(Function));
  });

  it("treats a nothing-to-compact refusal as information, not a failure", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onError(new Error("Nothing to compact (session too small)"));

    const last = notifyCalls[notifyCalls.length - 1];
    expect(last.level).toBe("info");
    expect(last.msg).toContain("nothing to compact");
    expect(last.msg).not.toContain("Compaction failed:");
  });

  it("reports an already-compacted refusal from the host as information", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onError(new Error("Already compacted"));

    const last = notifyCalls[notifyCalls.length - 1];
    expect(last.level).toBe("info");
    expect(last.msg).toContain("already compacted");
  });
});

// ── Feature 1: Follow-up prompt after compaction ────────────────────────────

describe("/blackhole follow-up prompt", () => {
  beforeEach(() => {
    mkdirSync(join(testRoot, "agent", "pi-blackhole"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("extracts follow-up text from /blackhole <args> and sends it after compaction", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("fix the auth bug", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const call = ctx.compact.mock.calls[0][0];
    expect(call.customInstructions).toBe("__pi_vcc__");
    // Simulate compaction completion — follow-up should fire
    call.onComplete();
    expect(sendUserMessageCalls).toHaveLength(1);
    expect(sendUserMessageCalls[0].content).toBe("fix the auth bug");
  });

  it("does NOT extract subcommands as follow-up", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("configure", ctx);

    // Should NOT compact — subcommand handled separately
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("treats 'settings' as an alias for 'configure'", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("settings", ctx);

    // Should open the config overlay (like configure), not compact
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("no args → no follow-up prompt sent", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const call = ctx.compact.mock.calls[0][0];
    call.onComplete();
    expect(sendUserMessageCalls).toHaveLength(0);
  });

  it("fires follow-up via sendUserMessage after compaction completes", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("continue the refactor", ctx);

    const call = ctx.compact.mock.calls[0][0];
    // Simulate compaction completion
    call.onComplete();

    // The follow-up should be sent as a user message
    expect(sendUserMessageCalls).toHaveLength(1);
    expect(sendUserMessageCalls[0].content).toBe("continue the refactor");
  });

  it("does not fire follow-up when compaction fails", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("continue", ctx);

    const call = ctx.compact.mock.calls[0][0];
    // Simulate compaction failure
    call.onError(new Error("context overflow"));

    expect(sendUserMessageCalls).toHaveLength(0);
  });
});
