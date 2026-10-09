import { expect, it, vi } from "vitest";
import { registerPiVccCommand } from "../src/commands/pi-vcc.js";
import { DEFAULTS } from "../src/core/unified-config.js";
vi.mock("../src/om/inline-compaction.js", () => ({ getCompactionIneligibility: () => { throw new Error("Forbidden private-adapter preflight"); } }));
it("/blackhole requests native compaction without consulting the captured-session adapter", async () => {
  let command: any;
  const compact = vi.fn();
  registerPiVccCommand({ registerCommand: (_: string, value: any) => command = value } as any,
    { config: { ...DEFAULTS, memory: false }, ensureConfig() {} } as any);
  await command.handler("", { cwd: process.cwd(), compact, sessionManager: { getSessionId: () => "fixture", getBranch: () => [] }, ui: { notify() {} } });
  expect(compact).toHaveBeenCalledOnce();
  expect(compact.mock.calls[0][0].customInstructions).toBe("__pi_vcc__");
});
