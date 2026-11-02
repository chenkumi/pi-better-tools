import { formatRef } from '../fold/ref.ts';
import { asRecord, clip, list, oneLine, redact, str } from '../fold/util.ts';
import { currentBranchIds } from './branch.ts';
import { scanLines } from './lines.ts';
import { compactJson } from './render.ts';
import { contentText } from './outline.ts';
import { isCurrent, pickSession, SessionReadError, type SessionFile } from './sessions.ts';

export const DEFAULT_GREP_LIMIT = 30;
export const MAX_GREP_LIMIT = 100;
const MAX_PATTERN = 200;
const SNIPPET_SIDE = 80;
const PARSE_LIMIT = 16 * 1024 * 1024;
const TIME_LIMIT_MS = 10_000;

export interface GrepRequest {
  sessionId?: string;
  /** Literal text, case-insensitive. */
  pattern: string;
  role?: 'user' | 'assistant' | 'tool';
  tool?: string;
  from?: number;
  to?: number;
  includeOtherBranches?: boolean;
  limit?: number;
  leafId?: string;
  signal?: AbortSignal;
}

export interface GrepResult {
  text: string;
  details: { sessionId: string; hits: number; hiddenOtherBranch: number; truncated: boolean; nextFrom?: number };
}

interface Searchable { label: string; role: 'user' | 'assistant' | 'tool'; tool?: string; text: string }

/** The searchable text of an entry. Thinking blocks and images are never searched. */
function searchable(entry: Record<string, unknown>): Searchable[] {
  const type = str(entry.type), message = asRecord(entry.message), found: Searchable[] = [];
  if (type === 'message' && message) {
    const role = str(message.role);
    if (role === 'user') found.push({ label: 'user', role: 'user', text: contentText(message.content).text });
    else if (role === 'assistant') {
      found.push({ label: 'assistant', role: 'assistant', text: contentText(message.content).text });
      for (const block of list(message.content)) {
        const b = asRecord(block);
        if (b?.type === 'toolCall') found.push({ label: `call ${str(b.name) ?? '?'}`, role: 'tool', tool: str(b.name), text: `${str(b.name) ?? ''} ${compactJson(b.arguments)}` });
      }
    } else if (role === 'toolResult') found.push({ label: `result ${str(message.toolName) ?? '?'}`, role: 'tool', tool: str(message.toolName), text: contentText(message.content).text });
    else if (role === 'bashExecution') found.push({ label: 'user-shell', role: 'user', text: `${str(message.command) ?? ''}\n${str(message.output) ?? ''}` });
  } else if (type === 'compaction' || type === 'branch_summary') found.push({ label: type, role: 'assistant', text: str(entry.summary) ?? '' });
  else if (type === 'custom_message') found.push({ label: `[${str(entry.customType) ?? 'custom'}]`, role: 'assistant', text: contentText(entry.content).text });
  return found;
}

function snippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_SIDE), end = Math.min(text.length, at + length + SNIPPET_SIDE);
  return `${start > 0 ? '…' : ''}${oneLine(redact(text.slice(start, end)), SNIPPET_SIDE * 2 + length + 2)}${end < text.length ? '…' : ''}`;
}

const whole = (value: unknown, name: string, min: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new SessionReadError(`"${name}" must be an integer >= ${min}.`);
  return value;
};

/**
 * Keyword search over the decoded conversation of one readable session. One hit line per matching entry, with a short redacted
 * snippet and the line reference to pass to session_read. Literal, case-insensitive matching only: a pattern chosen by the
 * model must not be able to stall the process.
 */
export async function grepSession(readable: readonly SessionFile[], request: GrepRequest): Promise<GrepResult> {
  const target = pickSession(readable, request.sessionId);
  const pattern = typeof request.pattern === 'string' ? request.pattern.trim() : '';
  if (pattern.length < 2 || pattern.length > MAX_PATTERN) throw new SessionReadError(`"pattern" must be 2-${MAX_PATTERN} characters of literal text (case-insensitive; regular expressions are not supported).`);
  const needle = pattern.toLowerCase();
  const limit = Math.min(MAX_GREP_LIMIT, request.limit === undefined ? DEFAULT_GREP_LIMIT : whole(request.limit, 'limit', 1));
  const from = request.from === undefined ? 2 : whole(request.from, 'from', 1);
  const to = request.to === undefined ? Number.POSITIVE_INFINITY : whole(request.to, 'to', from);
  const onBranch = request.includeOtherBranches === true ? undefined : await currentBranchIds(target.file, isCurrent(readable, target) ? request.leafId : undefined);
  const started = Date.now();

  const hits: string[] = [];
  let hidden = 0, skipped = 0, scanned = 0, nextFrom: number | undefined, stopped: string | undefined, matches = 0;
  for await (const item of scanLines(target.file, from, to)) {
    if (request.signal?.aborted) throw new Error('Aborted');
    if (Date.now() - started > TIME_LIMIT_MS) { nextFrom = item.line; stopped = 'time limit'; break; }
    scanned = item.line;
    if (item.text === undefined || item.bytes > PARSE_LIMIT) { skipped++; continue; }
    let entry: Record<string, unknown> | undefined;
    try { entry = asRecord(JSON.parse(item.text)); } catch { continue; }
    if (!entry) continue;
    let count = 0, first: { label: string; text: string; at: number } | undefined;
    for (const part of searchable(entry)) {
      if ((request.role && part.role !== request.role) || (request.tool && part.tool !== request.tool)) continue;
      const lower = part.text.toLowerCase();
      let at = lower.indexOf(needle);
      while (at !== -1) { count++; first ??= { label: part.label, text: part.text, at }; at = lower.indexOf(needle, at + needle.length); }
    }
    if (!first) continue;
    if (onBranch && !onBranch.has(str(entry.id) ?? '')) { hidden++; continue; }
    if (hits.length >= limit) { nextFrom = item.line; stopped = 'limit'; break; }
    matches += count;
    hits.push(`${formatRef({ line: item.line, id: str(entry.id) ?? '?', bytes: item.bytes })} ${first.label}: ${snippet(first.text, first.at, pattern.length)}${count > 1 ? ` (×${count})` : ''}`);
  }
  const header = `Search ${JSON.stringify(clip(redact(pattern), 60))} in session ${target.id}: ${hits.length} matching entr${hits.length === 1 ? 'y' : 'ies'}${matches > hits.length ? ` (${matches} occurrences)` : ''}${stopped ? `; stopped at ${stopped}` : `; searched to L${scanned || from}`}`;
  const footer: string[] = [];
  if (nextFrom !== undefined) footer.push(`[more: call session_grep again with from=${nextFrom}${isCurrent(readable, target) ? '' : ` session_id=${target.id}`}]`);
  if (hidden) footer.push(`[${hidden} further match${hidden === 1 ? '' : 'es'} on abandoned branches hidden; set include_other_branches=true to see them]`);
  if (skipped) footer.push(`[${skipped} line${skipped === 1 ? '' : 's'} too large to search were skipped]`);
  const text = [header, ...hits, ...footer].join('\n');
  return { text, details: { sessionId: target.id, hits: hits.length, hiddenOtherBranch: hidden, truncated: nextFrom !== undefined, ...(nextFrom !== undefined ? { nextFrom } : {}) } };
}
