import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeOrphaned, deleteOrphanedBatch } from "../src/om/cleanup.js";
import { handleCleanup } from "../src/commands/cleanup.js";
import { savePendingObservation, savePendingReflection, savePendingDropped, readPendingState, writePendingCursors, listPendingSessions } from "../src/om/pending.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));
const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(), getAgentDir: () => fixture.root,
}));
let pending: string, sessions: string, live: string;
beforeEach(() => {
  fixture.root = fs.mkdtempSync(join(tmpdir(), "bh-persistence-safety-"));
  pending = join(fixture.root, "pi-blackhole", "live-pending.json");
  sessions = join(fixture.root, "sessions");
  live = join(sessions, "live.jsonl");
  fs.mkdirSync(join(fixture.root, "pi-blackhole")); fs.mkdirSync(sessions);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

for (const [name, save] of [["observation", savePendingObservation], ["reflection", savePendingReflection], ["dropper", savePendingDropped]] as const) {
  test(`${name} failed write is observable and preserves old batches through cursor flush`, () => {
    savePendingObservation("live", { coversUpToId: "a", data: { observations: ["A"] } });
    const original = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).includes("pi-blackhole")) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      return original(...args);
    });
    expect(() => save("live", { coversUpToId: "b", data: {} })).toThrow(/ENOSPC/);
    spy.mockRestore();
    writePendingCursors("live", { observer: { entryId: "a", state: "recorded" } });
    expect(readPendingState("live").observationBatches?.map(b => b.coversUpToId)).toEqual(["a"]);
    expect(fs.readdirSync(join(fixture.root, "pi-blackhole")).filter(p => p.endsWith(".tmp"))).toEqual([]);
  });
}

test("readonly pending listing isolates corrupt/unreadable entries from valid sessions", () => {
  savePendingObservation("live", { coversUpToId: "a", data: {} });
  fs.writeFileSync(join(fixture.root, "pi-blackhole", "corrupt-pending.json"), "{bad");
  fs.writeFileSync(join(fixture.root, "pi-blackhole", "denied-pending.json"), "{}");
  const original = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith("denied-pending.json")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return original(...args);
  });
  expect(listPendingSessions()).toEqual(["live"]);
});

test("unreadable live header never authorizes orphan deletion", () => {
  fs.writeFileSync(live, JSON.stringify({ type: "session", id: "live" }) + "\n");
  savePendingObservation("live", { coversUpToId: "a", data: {} });
  const original = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === live) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return original(...args);
  });
  const report = analyzeOrphaned(fixture.root, [sessions]);
  expect(report.orphaned).toEqual([]);
  expect(deleteOrphanedBatch(report.all, fixture.root, [sessions])).toBe(0);
  expect(fs.existsSync(pending)).toBe(true);
});

test("deletion rechecks sessions created after picker snapshot", () => {
  savePendingObservation("live", { coversUpToId: "a", data: {} });
  const report = analyzeOrphaned(fixture.root, [sessions]);
  expect(report.orphaned).toHaveLength(1);
  fs.writeFileSync(live, JSON.stringify({ type: "session", id: "live" }) + "\n");
  expect(deleteOrphanedBatch(report.orphaned, fixture.root, [sessions])).toBe(0);
  expect(fs.existsSync(pending)).toBe(true);
});

test("public cleanup protects current session outside scanned directories", async () => {
  savePendingObservation("live", { coversUpToId: "a", data: {} });
  const custom = vi.fn(); const notify = vi.fn();
  await handleCleanup({ mode: "interactive", sessionManager: { getSessionId: () => "live", getSessionFile: () => undefined }, ui: { custom, notify } } as never);
  expect(custom).not.toHaveBeenCalled();
  expect(fs.existsSync(pending)).toBe(true);
});

test("a proven orphan can still be deleted", () => {
  savePendingObservation("live", { coversUpToId: "a", data: {} });
  expect(deleteOrphanedBatch(analyzeOrphaned(fixture.root, [sessions]).orphaned, fixture.root, [sessions])).toBe(1);
  expect(fs.existsSync(pending)).toBe(false);
});
