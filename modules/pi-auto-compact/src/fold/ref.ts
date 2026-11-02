import { formatBytes } from './util.ts';

/**
 * Where an entry lives in the session file. `line` is the 1-based line of the JSONL file (the header is line 1) and `id` the
 * entry id; the `session_read` tool checks both, so a line that no longer matches is reported instead of read wrongly.
 */
export interface EntryRef {
  line: number;
  id: string;
  /** Size of the entry's JSON line; shown only when large enough to matter. */
  bytes?: number;
}

export const REF_ID_LENGTH = 8;
const SIZE_HINT_MIN = 8 * 1024;

const idPart = (id: string) => id.slice(0, REF_ID_LENGTH);

/** `⟦L1234:a1b2c3d4⟧`, or `⟦L1234:a1b2c3d4 · 82.0KB⟧` for a large line. */
export function formatRef(ref: EntryRef): string {
  const size = ref.bytes !== undefined && ref.bytes >= SIZE_HINT_MIN ? ` · ${formatBytes(ref.bytes)}` : '';
  return `⟦L${ref.line}:${idPart(ref.id)}${size}⟧`;
}

/** Consecutive conversation entries collapse to one range: `⟦L120–124:a1b2c3d4⟧` (the id belongs to the first line). */
export function formatRange(first: EntryRef, lastLine: number): string {
  return lastLine > first.line ? `⟦L${first.line}–${lastLine}:${idPart(first.id)}⟧` : formatRef(first);
}
