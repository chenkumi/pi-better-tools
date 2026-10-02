import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_INLINE_BYTES = 24 * 1024;
export const MAX_INLINE_LINES = 1000;
export const MAX_STRUCTURED_BYTES = 64 * 1024;
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
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('OUTPUT_TOO_LARGE: cleaned output exceeds 2 MiB');
  const truncated = Buffer.byteLength(text) > MAX_INLINE_BYTES || text.split('\n').length > MAX_INLINE_LINES;
  let content = text;
  let fullOutputPath: string | undefined;
  if (truncated) {
    const dir = await mkdtemp(join(tmpdir(), 'pi-web-tools-'));
    fullOutputPath = join(dir, 'content.txt');
    await writeFile(fullOutputPath, text, { mode: 0o600, flag: 'wx' });
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
