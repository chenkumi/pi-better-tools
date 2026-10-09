import { beforeEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanNotificationEntries } from "../src/core/notification-evidence-scan.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
});
function withFile(text: string, fn: (file: string) => void) {
  const dir = fs.mkdtempSync(join(tmpdir(), "blackhole-scan-boundary-"));
  try { const file = join(dir, "session.jsonl"); fs.writeFileSync(file, text); fn(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function paddedLine(bytes: number) {
  const prefix = '{"id":"exact","padding":"', suffix = '"}';
  const line = prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
  expect(Buffer.byteLength(line)).toBe(bytes); return line;
}
function assertClosed() {
  expect(fs.openSync).toHaveBeenCalledTimes(1); expect(fs.closeSync).toHaveBeenCalledTimes(1);
  const fd = vi.mocked(fs.openSync).mock.results[0].value;
  expect(fs.closeSync).toHaveBeenCalledWith(fd);
}
describe("evidence scanner deterministic boundaries and finally-close", () => {
  it("accepts an exact 65536-byte JSON line before newline", () => {
    withFile(paddedLine(65536) + "\n", file => {
      const entries: any[] = [], stats = scanNotificationEntries(file, e => { entries.push(e); return true; });
      expect(entries.map(e => e.id)).toEqual(["exact"]); expect(stats.reasons).toEqual([]);
      expect(stats.parsedEntries).toBe(1); expect(stats.maxBufferedBytes).toBe(65536); assertClosed();
    });
  });
  it("handles CR/LF split across the read-chunk boundary and UTF8 tail", () => {
    withFile(paddedLine(65535) + '\r\n{"id":"跨塊"}\r\n', file => {
      const entries: any[] = [], stats = scanNotificationEntries(file, e => { entries.push(e); return true; });
      expect(entries.map(e => e.id)).toEqual(["exact", "跨塊"]); expect(stats.reasons).toEqual([]);
      expect(stats.parsedEntries).toBe(2); expect(stats.bytesRead).toBeGreaterThan(65536); assertClosed();
    });
  });
  it("preserves a final JSON line without newline", () => {
    withFile('{"id":"tail"}', file => {
      const entries: any[] = [], stats = scanNotificationEntries(file, e => { entries.push(e); return true; });
      expect(entries.map(e => e.id)).toEqual(["tail"]); expect(stats.parsedEntries).toBe(1);
      expect(stats.reasons).toEqual([]); assertClosed();
    });
  });
  it("closes the actual opened fd when consume throws, without swallowing/reclassifying", () => {
    const error = new Error("CONSUME_SENTINEL");
    withFile('{"id":"throw"}\n', file => {
      expect(() => scanNotificationEntries(file, () => { throw error; })).toThrow(error); assertClosed();
    });
  });
  it("closes the actual opened fd when read throws, without consuming any entry", () => {
    const error = Object.assign(new Error("READ_SENTINEL"), { code: "EIO" });
    vi.mocked(fs.readSync).mockImplementationOnce(() => { throw error; });
    withFile('{"id":"unread"}\n', file => {
      const consume = vi.fn(() => true);
      expect(() => scanNotificationEntries(file, consume)).toThrow(error);
      expect(consume).not.toHaveBeenCalled(); assertClosed();
    });
  });
});
