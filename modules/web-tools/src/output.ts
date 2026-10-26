import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_INLINE_BYTES = 24 * 1024;
export const MAX_INLINE_LINES = 1000;
export const MAX_STRUCTURED_BYTES = 64 * 1024;
const OUTPUT_PREFIX = 'pi-web-tools-';
/** Saved full outputs are for follow-up reads in the same work session, not long-term storage. */
export const OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Upper bound of lstat calls per sweep; foreign names are skipped without a stat and do not count. */
const MAX_SWEEP_STATS = 512;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweep = -Infinity;

/**
 * Best effort: removes output directories older than the retention period; never blocks or fails a result.
 * Work per call is bounded, and at most one sweep runs per interval per process.
 */
export async function sweepOldOutputs(root = tmpdir(), now = Date.now()): Promise<void> {
  try {
    const names = (await readdir(root)).filter(name => name.startsWith(OUTPUT_PREFIX)).slice(0, MAX_SWEEP_STATS);
    for (const name of names) {
      const path = join(root, name);
      try {
        const info = await lstat(path);
        if (info.isDirectory() && now - info.mtimeMs > OUTPUT_RETENTION_MS) await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch { /* another process may have removed it */ }
    }
  } catch { /* housekeeping only */ }
}
export function sanitizeText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}
export function clip(text: string, maxBytes: number, maxLines: number): string {
  const lines = text.split('\n').slice(0, maxLines).join('\n');
  let size = 0, result = '';
  for (const char of lines) {
    const n = Buffer.byteLength(char);
    if (size + n > maxBytes) break;
    size += n; result += char;
  }
  return result;
}
export async function toolOutput<T extends object>(text: string, metadata: Record<string, unknown> = {}, data?: T) {
  text = sanitizeText(text);
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('OUTPUT_TOO_LARGE: cleaned output exceeds 2 MiB; narrow it with extraction:"main" or fetch a more specific page.');
  const truncated = Buffer.byteLength(text) > MAX_INLINE_BYTES || text.split('\n').length > MAX_INLINE_LINES;
  let content = text;
  let fullOutputPath: string | undefined;
  if (truncated) {
    if (Date.now() - lastSweep >= SWEEP_INTERVAL_MS) { lastSweep = Date.now(); await sweepOldOutputs(); }
    const dir = await mkdtemp(join(tmpdir(), OUTPUT_PREFIX));
    fullOutputPath = join(dir, 'content.txt');
    try { await writeFile(fullOutputPath, text, { mode: 0o600, flag: 'wx' }); }
    catch (error) { await rm(dir, { recursive: true, force: true }).catch(() => {}); throw error; }
    const notice = `\n\n[Output truncated. Full cleaned content: ${fullOutputPath}\nUse read with offset/limit. Temporary file; may not survive OS cleanup.]`;
    content = clip(text, MAX_INLINE_BYTES - Buffer.byteLength(notice), MAX_INLINE_LINES - 4) + notice;
  }
  const bounds = { truncated, ...(fullOutputPath ? { fullOutputPath } : {}) };
  const structuredContent: { text: string; data?: T; dataOmitted: boolean; truncated: boolean; fullOutputPath?: string } = {
    text: content, ...bounds, ...(data ? { data } : {}), dataOmitted: false,
  };
  // Bound the whole serialized envelope, including escaped text and extra data.
  if (Buffer.byteLength(JSON.stringify(structuredContent)) > MAX_STRUCTURED_BYTES) {
    delete structuredContent.data;
    structuredContent.dataOmitted = true;
  }
  return {
    content: [{ type: 'text' as const, text: content }],
    details: { ...metadata, ...bounds },
    structuredContent,
  };
}
