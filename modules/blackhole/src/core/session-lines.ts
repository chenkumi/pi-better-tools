/** Incremental bounded session JSONL scanner shared by recall and #N lookup.
 * Oversized/uninspected lines stop the scan: their message count is unknown,
 * so numbering a later tail would fabricate numeric references.
 */
import { closeSync, fstatSync, openSync, readSync } from "fs";
export interface SessionScanResult {
  missing: boolean;
  parseErrors: number;
  incomplete: boolean;
  reasons: string[];
  bytesRead: number;
  maxBufferedBytes: number;
}
export const SESSION_SCAN_MAX_BYTES = 32 * 1024 * 1024;
export const SESSION_LINE_MAX_BYTES = 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
export interface SessionScanLimits { maxScanBytes?: number; maxLineBytes?: number }
const limit = (value: number | undefined, maximum: number) =>
  Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, maximum) : maximum;
export const scanSessionEntries = (
  sessionFile: string,
  onEntry: (entry: any) => void,
  limits: SessionScanLimits = {},
): SessionScanResult => {
  const state: SessionScanResult = { missing: false, parseErrors: 0, incomplete: false, reasons: [], bytesRead: 0, maxBufferedBytes: 0 };
  const maxScan = limit(limits.maxScanBytes, SESSION_SCAN_MAX_BYTES);
  const maxLine = limit(limits.maxLineBytes, SESSION_LINE_MAX_BYTES);
  const incomplete = (reason: string) => { state.incomplete = true; state.reasons.push(reason); };
  const processLine = (line: Buffer) => {
    const text = line.toString("utf8");
    if (!text.trim()) return;
    try { onEntry(JSON.parse(text)); } catch { state.parseErrors++; }
  };
  let fd: number;
  try { fd = openSync(sessionFile, "r"); } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") { state.missing = true; return state; }
    throw err;
  }
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
    const pending = Buffer.allocUnsafe(maxLine);
    let pendingLength = 0;
    const append = (segment: Buffer): boolean => {
      if (pendingLength + segment.length > maxLine) { incomplete("line_limit"); return false; }
      segment.copy(pending, pendingLength);
      pendingLength += segment.length;
      state.maxBufferedBytes = Math.max(state.maxBufferedBytes, pendingLength);
      return true;
    };
    while (true) {
      const remaining = maxScan - state.bytesRead;
      if (remaining === 0) {
        if (fstatSync(fd).size > state.bytesRead) incomplete("scan_limit");
        else if (pendingLength) processLine(pending.subarray(0, pendingLength));
        break;
      }
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, remaining), null);
      if (n === 0) { if (pendingLength) processLine(pending.subarray(0, pendingLength)); break; }
      state.bytesRead += n;
      let start = 0;
      for (let i = 0; i < n; i++) {
        if (chunk[i] !== 0x0a) continue;
        if (!append(chunk.subarray(start, i))) return state;
        processLine(pending.subarray(0, pendingLength));
        pendingLength = 0;
        start = i + 1;
      }
      if (!append(chunk.subarray(start, n))) return state;
    }
  } finally { closeSync(fd); }
  if (state.parseErrors) incomplete("malformed_json");
  return state;
};
