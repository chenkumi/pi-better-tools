import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ attempts: 0, runtime: undefined as any }));
vi.mock("../src/core/settings", () => ({ scaffoldSettings() {} }));
vi.mock("../src/hooks/before-compact", () => ({ registerBeforeCompactHook() {} }));
vi.mock("../src/hooks/compact-failed", () => ({ registerCompactFailedHook() {} }));
vi.mock("../src/hooks/compaction-context", () => ({ registerCompactionContextHook() {} }));
vi.mock("../src/hooks/cosmetic-output", () => ({ registerPreCompactionOutput() {} }));
vi.mock("../src/commands/pi-vcc", () => ({ registerPiVccCommand() {} }));
vi.mock("../src/commands/memory", () => ({ registerMemoryCommand() {} }));
vi.mock("../src/commands/vcc-recall", () => ({ registerVccRecallCommand() {} }));
vi.mock("../src/commands/blackhole-export", () => ({ registerBlackholeExportCommand() {} }));
vi.mock("../src/om/consolidation", () => ({ registerConsolidationTrigger() {} }));
vi.mock("../src/om/status-bar", () => ({ registerStatusBar() {} }));
vi.mock("../src/tools/recall", () => ({ registerRecallTool() {} }));
vi.mock("../src/om/provider-stream", () => ({ captureRegisteredProviderStreams() {} }));
vi.mock("../src/om/runtime", () => ({ Runtime: class { config = { memory: false }; constructor() { state.runtime = this; } reloadConfig(_cwd: string, onWarn: (text: string) => void) { this.config = { memory: false }; onWarn("UNIFIED_WARNING"); } } }));
vi.mock("../src/pi-base/blackhole-settings", () => ({ config: {
  resolveHostSession(base: any, ctx: any) { return ctx.leaf === "C" ? { ...base, memory: true } : base; },
  notifyWarnings(result: any, notify: (text: string) => void) { state.attempts++; for (const warning of result.warnings) notify(warning.message); },
} }));
beforeEach(() => { state.attempts = 0; state.runtime = undefined; });
for (const shape of ["host-no-op", "absent-ui", "absent-notify"] as const) it(`W2 factory skips diagnostic delivery for ${shape}`, async () => {
  const { default: factory } = await import("../index.js"); const handlers = new Map<string, any>();
  await factory({ on(name: string, handler: any) { handlers.set(name, handler); } } as any);
  const notify = vi.fn(), ctx = { cwd: "/isolated", hasUI: shape !== "host-no-op", ui: shape === "host-no-op" ? { notify } : shape === "absent-notify" ? {} : undefined };
  handlers.get("session_start")({}, ctx);
  expect(state.attempts).toBe(0); expect(notify).not.toHaveBeenCalled();
  handlers.get("session_tree")({}, { ...ctx, hasUI: true, ui: { notify } });
  expect(state.attempts).toBe(1); expect(notify).toHaveBeenCalledWith("UNIFIED_WARNING", "warning");
});
it("W2 outer unified-warning callback navigation reprojects from lower-layer base", async () => {
  const { default: factory } = await import("../index.js"); const handlers = new Map<string, any>();
  await factory({ on(name: string, handler: any) { handlers.set(name, handler); } } as any);
  const ctx = { cwd: "/isolated", hasUI: true, leaf: "C", ui: { notify() { ctx.leaf = "P"; } } };
  handlers.get("session_start")({}, ctx);
  expect(ctx.leaf).toBe("P"); expect(state.runtime.config).toEqual({ memory: false });
});
