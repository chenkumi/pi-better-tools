import { closeSync, openSync, readSync } from "node:fs";

/** Evidence-only scanner. Does not change the legacy raw-message/global-index reader. */
export interface EvidenceScanStats { bytesRead: number; parsedEntries: number; lines: number; maxBufferedBytes: number; reasons: string[] }
export function scanNotificationEntries(file: string, consume: (entry: any) => boolean): EvidenceScanStats {
  const stats: EvidenceScanStats = { bytesRead: 0, parsedEntries: 0, lines: 0, maxBufferedBytes: 0, reasons: [] };
  const mark = (reason: string) => { if (!stats.reasons.includes(reason)) stats.reasons.push(reason); };
  let fd: number;
  try { fd = openSync(file, "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return stats; throw error; }
  const limit = 32 * 1024 * 1024, lineLimit = 64 * 1024;
  const chunk = Buffer.allocUnsafe(lineLimit), line = Buffer.allocUnsafe(lineLimit);
  let length = 0, oversized = false, stopped = false;
  const flush = () => {
    if (++stats.lines > 100000) { mark("entry_limit"); stopped = true; return; }
    if (oversized) mark("line_limit");
    else if (length) {
      const text = line.subarray(0, length).toString("utf8");
      if (text.trim()) {
        let value: any;
        try { value = JSON.parse(text); } catch { mark("malformed_json"); length = 0; return; }
        stats.parsedEntries++;
        // Projection faults are not misclassified as JSON parse faults.
        if (!consume(value)) stopped = true;
      }
    }
    length = 0; oversized = false;
  };
  try {
    while (!stopped && stats.bytesRead < limit) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, limit - stats.bytesRead), null);
      if (!n) { if (length || oversized) flush(); break; }
      stats.bytesRead += n;
      for (let i = 0; i < n && !stopped; i++) {
        if (chunk[i] === 10) flush();
        else if (!oversized) {
          if (length === lineLimit) { oversized = true; length = 0; mark("line_limit"); }
          else { line[length++] = chunk[i]; stats.maxBufferedBytes = Math.max(stats.maxBufferedBytes, length); }
        }
      }
    }
    // Conservative when exactly at the limit: do not read/parse more to prove EOF.
    if (!stopped && stats.bytesRead === limit) mark("scan_byte_limit");
  } finally { closeSync(fd); }
  return stats;
}
