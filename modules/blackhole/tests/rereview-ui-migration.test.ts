import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStatusBar } from "../src/om/status-bar.js";
import { registerMemoryCommand } from "../src/commands/memory.js";
import { scaffoldConfig, saveUnifiedConfig, saveUnifiedConfigScoped, loadUnifiedConfig, DEFAULTS } from "../src/core/unified-config.js";
import { config } from "../src/pi-base/blackhole-settings.js";
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ignored = ["compactAfterPreset", "midRunCompaction", "tailBehavior", "retainedToolOutputMaxTokens", "compactAfterTokens", "compactAfterRatio", "compactReserveTokens"];
function isolated() { const d = mkdtempSync(join(tmpdir(), "bh-migration-rereview-")); dirs.push(d); const cwd = join(d, "work"), global = join(d, "pi-blackhole"); mkdirSync(cwd); mkdirSync(global); vi.stubEnv("PI_CODING_AGENT_DIR", d); return { d, cwd, global, file: join(global, "pi-blackhole-config.json") }; }
it("current example contains no ignored controls while keeping active worker/debug/output choices", () => {
  const example = JSON.parse(readFileSync(new URL("../example-config.json", import.meta.url), "utf8"));
  for (const key of [...ignored, "compactAfterPresets"]) expect(example).not.toHaveProperty(key);
  for (const key of ["memory", "sessionFallback", "fullFoldAlways", "debug", "recallResponseMaxChars", "observationsPoolMaxTokens", "model", "observerModel"]) expect(example).toHaveProperty(key);
});
it("migration cold scaffold and explicit modal/unified writes never regenerate ignored keys", () => {
  const { cwd, global, file } = isolated(); scaffoldConfig(); const warnings: string[] = []; loadUnifiedConfig(cwd, m => warnings.push(m));
  expect(ignored.filter(k => k in JSON.parse(readFileSync(file, "utf8")))).toEqual([]); expect(warnings.filter(w => w.includes("Legacy settings"))).toEqual([]);
  config.save({ ...DEFAULTS, debug: true }, "global", cwd, global);
  expect(ignored.filter(k => k in JSON.parse(readFileSync(file, "utf8")))).toEqual([]);
  saveUnifiedConfig({ ...DEFAULTS, debug: false });
  expect(ignored.filter(k => k in JSON.parse(readFileSync(file, "utf8")))).toEqual([]);
  saveUnifiedConfigScoped({ ...DEFAULTS, debug: false }, "project", cwd);
  expect(ignored.filter(k => k in JSON.parse(readFileSync(join(cwd, ".pi/pi-blackhole-config.json"), "utf8")))).toEqual([]);
});
it("legacy read is readonly; explicit save removes only ignored controls preserving all other existing data", () => {
  const { cwd, global, file } = isolated(); const raw = { compactAfterPreset: "custom", midRunCompaction: "off", tailBehavior: "minimal", retainedToolOutputMaxTokens: 20000, memory: true, fullFoldAlways: true, debug: true, sessionFallback: false, model: { provider: "safe", id: "safe", custom: "preserved" }, compactAfterPresets: { custom: [{ window: 1000, ratio: 0.5 }] }, unknown: { literal: "unchanged" } }; const bytes = JSON.stringify(raw); writeFileSync(file, bytes);
  const read = config.loadWithWarnings(cwd, global); expect(read.warnings.some(w => w.message.includes("Pi owns compaction"))).toBe(true); expect(readFileSync(file, "utf8")).toBe(bytes);
  // The actual global edit modal starts from layerValues(global), not the
  // effective env/session display. PASSIVE must not be saved into the file.
  config.save({ ...config.layerValues("global", cwd, global), statusBar: false }, "global", cwd, global); const saved = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ignored) expect(saved).not.toHaveProperty(key);
  const savedBytes = readFileSync(file, "utf8"), reopened = config.loadWithWarnings(cwd, global); expect(readFileSync(file, "utf8")).toBe(savedBytes);
  const legacyKeys = reopened.warnings.flatMap(w => w.message.match(/Legacy settings \(([^)]*)\)/)?.[1].split(", ") ?? []);
  expect(legacyKeys).toEqual(["compactAfterPresets"]);
  for (const key of ["memory", "fullFoldAlways", "debug", "sessionFallback", "model", "compactAfterPresets", "unknown"]) expect(saved[key]).toEqual((raw as any)[key]);
  for (const key of ignored) expect((config as any).opts.fields(DEFAULTS).find((f: any) => f.key === key)?.type).toBe("readonly");
  expect((config as any).opts.fields(DEFAULTS).find((f: any) => f.key === "showPreCompactionMessage").type).toBe("boolean");
});
it("active X and memory command are invariant under all legacy thresholds, with honest native unknown and worker lifecycle", async () => {
  vi.useFakeTimers(); const handlers = new Map<string, Function>(), commands = new Map<string, any>(); const status = vi.fn(), notify = vi.fn(), compact = vi.fn();
  const pi: any = { on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, definition: any) => commands.set(name, definition) };
  const runtime: any = { config: { ...DEFAULTS, statusBar: true }, ensureConfig() {}, consolidationInFlight: false };
  registerStatusBar(pi, runtime); registerMemoryCommand(pi, runtime);
  const ctx: any = { ui: { setStatus: status, notify }, sessionManager: { getBranch: () => [], getSessionId: () => "ui" }, model: { contextWindow: 8192 }, getContextUsage: () => ({ tokens: 2048, contextWindow: 8192, percent: 25 }), compact };
  handlers.get("session_start")!({}, ctx); await commands.get("blackhole-memory").handler("status", ctx);
  const initial = status.mock.calls.at(-1)?.[1], memory = notify.mock.calls.at(-1)?.[0];
  expect(initial).toMatch(/Pi-owned|Pi owned/i); expect(memory).toMatch(/budget.*unknown|unknown.*budget/i); expect(memory).not.toMatch(/Compaction:.*triggers at|preset:/i);
  Object.assign(runtime.config, { compactAfterPreset: "custom", compactAfterTokens: 1, compactAfterRatio: 0.01, compactReserveTokens: 8191 }); handlers.get("agent_end")!({}, ctx); await commands.get("blackhole-memory").handler("status", ctx);
  expect(status.mock.calls.at(-1)?.[1]).toBe(initial); expect(notify.mock.calls.at(-1)?.[0]).toBe(memory); expect(compact).not.toHaveBeenCalled();
  runtime.config.memory = false; runtime.consolidationInFlight = true; runtime.consolidationPhase = "observer"; handlers.get("turn_end")!({}, ctx);
  expect(status.mock.calls.at(-1)?.[1]).not.toMatch(/O▕|P▕/); expect(status.mock.calls.at(-1)?.[1]).toContain("[observer]");
  handlers.get("session_shutdown")!(); expect(vi.getTimerCount()).toBe(0);
});
