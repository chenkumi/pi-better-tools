import { scanLines } from './lines.ts';
import { currentBranchIds } from './branch.ts';
import { type LineEntry, projectOutline } from './outline.ts';
import { isCurrent, pickSession, SessionReadError, type SessionFile } from './sessions.ts';

export const DEFAULT_WINDOW_LINES = 60;
export const MAX_WINDOW_LINES = 400;
export const DEFAULT_WINDOW_CHARS = 8_000;
export const MAX_WINDOW_CHARS = 30_000;
/** How far past the range to look for the results of calls made near its end, and before it for the calls of results near its start. */
const LOOKAHEAD_LINES = 60;
const LOOKBEHIND_LINES = 40;
const PARSE_LIMIT = 16 * 1024 * 1024;

export interface WindowRequest {
  sessionId?: string;
  /** First line of the range. */
  from?: number;
  /** Last line of the range (default: from + 59). */
  to?: number;
  /** Read backwards instead: the `count` lines before this line. */
  before?: number;
  count?: number;
  maxChars?: number;
  /** Id of the current leaf, so the live branch can be told from abandoned ones. */
  leafId?: string;
}

export interface WindowResult {
  text: string;
  details: { sessionId: string; from: number; to: number; entries: number; truncated: boolean; nextFrom?: number };
}

const whole = (value: unknown, name: string, min: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new SessionReadError(`"${name}" must be an integer >= ${min}.`);
  return value;
};

export async function readWindow(readable: readonly SessionFile[], request: WindowRequest): Promise<WindowResult> {
  const target = pickSession(readable, request.sessionId);
  let from: number, to: number;
  if (request.before !== undefined) {
    if (request.from !== undefined || request.to !== undefined) throw new SessionReadError('Use either "before" (with "count") or "from" (with "to"), not both.');
    const before = whole(request.before, 'before', 2);
    const count = Math.min(MAX_WINDOW_LINES, request.count === undefined ? DEFAULT_WINDOW_LINES : whole(request.count, 'count', 1));
    to = before - 1;
    from = Math.max(2, to - count + 1);
  } else {
    if (request.from === undefined) throw new SessionReadError('Give "from" (a line number) or "before" (read the lines before a line).');
    from = whole(request.from, 'from', 1);
    to = request.to === undefined ? from + DEFAULT_WINDOW_LINES - 1 : whole(request.to, 'to', from);
    if (to - from + 1 > MAX_WINDOW_LINES) throw new SessionReadError(`At most ${MAX_WINDOW_LINES} lines per call; continue with the "from" value the previous result gave.`);
  }
  const maxChars = Math.min(MAX_WINDOW_CHARS, request.maxChars === undefined ? DEFAULT_WINDOW_CHARS : whole(request.maxChars, 'max_chars', 1000));

  const items: LineEntry[] = [];
  for await (const raw of scanLines(target.file, Math.max(1, from - LOOKBEHIND_LINES), to + LOOKAHEAD_LINES)) {
    let entry: Record<string, unknown> | undefined;
    if (raw.text !== undefined && raw.bytes <= PARSE_LIMIT) {
      try { const parsed = JSON.parse(raw.text) as unknown; if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) entry = parsed as Record<string, unknown>; } catch { /* shown as unreadable */ }
    }
    items.push({ line: raw.line, bytes: raw.bytes, ...(entry ? { entry } : {}) });
  }
  if (items.length === 0 || items[items.length - 1]!.line < from) throw new SessionReadError(`Line ${from} is past the end of the session file.`);
  const onBranch = await currentBranchIds(target.file, isCurrent(readable, target) ? request.leafId : undefined);
  const groups = projectOutline(items, from, to, onBranch);

  const out: string[] = [];
  let used = 0, shownTo = Math.min(to, items[items.length - 1]!.line), nextFrom: number | undefined;
  for (const group of groups) {
    const size = group.lines.reduce((sum, line) => sum + line.length + 1, 0);
    if (used + size > maxChars && out.length > 0) { nextFrom = group.line; shownTo = group.line - 1; break; }
    out.push(...group.lines);
    used += size;
  }
  const other = onBranch ? groups.filter(group => group.lines[0]!.includes('(other branch)')).length : 0;
  const header = `Session ${target.id} L${from}–${shownTo}: ${groups.length === 0 ? 'no conversation entries' : `${out.length} outline line${out.length === 1 ? '' : 's'}`}${other ? `; ${other} entr${other === 1 ? 'y' : 'ies'} on abandoned branches (marked)` : ''}`;
  const footer: string[] = [];
  if (nextFrom !== undefined) footer.push(`[more: call session_window again with from=${nextFrom} to=${to}${isCurrent(readable, target) ? '' : ` session_id=${target.id}`}]`);
  if (from > 2) footer.push(`[earlier: call session_window with before=${from}]`);
  const text = [header, ...out, ...footer].join('\n');
  return { text, details: { sessionId: target.id, from, to: shownTo, entries: groups.length, truncated: nextFrom !== undefined, ...(nextFrom !== undefined ? { nextFrom } : {}) } };
}
