import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessionEntries } from "../src/core/session-lines.js";
import * as loader from "../src/core/load-messages.js";
import { loadGlobalIndexById } from "../src/core/global-indices.js";
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function file(text: string) { const dir = mkdtempSync(join(tmpdir(), "bh-bounds-")); dirs.push(dir); const path = join(dir, "session.jsonl"); writeFileSync(path, text); return path; }
const message = (id: string, content: string) => JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content, timestamp: 0 } });
it.each([true, false])("R16 caps giant line before parsing (newline=%s), no invented tail indices", newline => {
  const path = file(message("first", "prefix") + "\n" + message("giant", "x".repeat(1024 * 1024 + 1)) + (newline ? "\n" + message("tail", "tail") + "\n" : ""));
  const seen: any[] = [];
  const scan: any = scanSessionEntries(path, entry => seen.push(entry));
  expect(seen.map(e => e.id)).toEqual(["first"]);
  expect(scan.incomplete).toBe(true);
  expect(scan.reasons).toContain("line_limit");
  expect(scan.maxBufferedBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(loader.loadAllMessages(path, false).rendered.map(e => e.index)).toEqual([0]);
  expect(loadGlobalIndexById(path)).toBeUndefined();
});
it("R16 scan byte counter enforces admission before read/parse", () => {
  const path = file(message("first", "prefix") + "\n" + message("tail", "tail"));
  const scan: any = (scanSessionEntries as any)(path, () => {}, { maxScanBytes: 128, maxLineBytes: 1024 });
  expect(scan.bytesRead).toBe(128);
  expect(scan.reasons).toContain("scan_limit");
  expect(scan.incomplete).toBe(true);
});
it("R16 retained payload and cache aggregate bytes are bounded, selected expansion keeps #N", () => {
  const text = Array.from({ length: 16 }, (_, i) => message(String(i), "x".repeat(256 * 1024))).join("\n") + "\n";
  const paths = Array.from({ length: 4 }, () => file(text));
  for (const path of paths) {
    const result: any = loader.loadAllMessages(path, true);
    expect(result.incomplete).toBe(true);
    expect(result.reasons).toContain("retained_limit");
    expect(result.retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    // Accounted bytes include both raw payload and rendered UTF16 strings.
    const actual = Buffer.byteLength(JSON.stringify(result.rawMessages)) + result.rendered.reduce((n: number, e: any) => n + e.summary.length * 2, 0);
    expect(result.retainedBytes).toBeGreaterThanOrEqual(actual);
  }
  const selected: any = (loader.loadAllMessages as any)(paths[0], true, undefined, new Set([15]));
  expect(selected.entryIds).toEqual(["15"]);
  expect(selected.rendered.map((e: any) => e.index)).toEqual([15]);
  expect(selected.incomplete).toBe(false);
  const stats = (loader as any).messageCacheStats();
  expect(stats.retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
});
