import { type EntryRef, formatRef } from '../fold/ref.ts';
import { foldToolUse, foldUnpairedCall, foldUnpairedResult } from '../fold/registry.ts';
import { asRecord, clip, num, oneLine, records, redact, str } from '../fold/util.ts';
import type { Item } from './items.ts';

/**
 * Rendering is a pure function of one item: it never depends on the budget, on neighbouring items or on how much history
 * there is. That is what keeps the start of a summary byte-identical from one compaction to the next (prompt cache).
 */
export const L3_TEXT_MAX = 400;
export const L2_TEXT_MAX = 1200;
const NOTE_MAX = 240;
const MAX_CALLS_PER_ITEM = 24;

const refText = (ref: EntryRef | undefined) => (ref ? `${formatRef(ref)} ` : '');
/** Conversation text is kept as written (the model already saw it, and the original stays readable with session_read). */
const say = (text: string, max: number) => clip(oneLine(text, max), max);

/**
 * What the user wrote is kept whole: the model cannot recover it any other way, and the ask is often in the last sentence.
 * Only a message longer than `max` (callers pass half of the section budget, so one paste cannot take over the section) keeps its
 * head and its tail, with the omitted size in between; the original stays readable with session_read through the reference.
 */
export function userSay(text: string, max: number): string {
  const flat = oneLine(text, Number.MAX_SAFE_INTEGER);
  if (flat.length <= max) return flat;
  const head = Math.floor(max * 0.6), tail = max - head;
  return `${flat.slice(0, head)} [… ${flat.length - head - tail} chars omitted …] ${flat.slice(flat.length - tail)}`;
}
/** Default limits, used when a caller renders a single item without a budget (half of the default L3 and L2 budgets). */
export const DEFAULT_USER_MAX_L3 = 3000;
export const DEFAULT_USER_MAX_L2 = 10_000;
/** Commands may carry credentials, so they are masked. */
const masked = (text: string, max: number) => clip(oneLine(redact(text), max), max);

const shellLine = (item: Item) => `${refText(item.ref)}!: ${masked(item.text, NOTE_MAX)}`;
const noteLine = (item: Item) => `${refText(item.ref)}[${oneLine(item.label ?? 'note', 40)}]: ${say(noteText(item.text), NOTE_MAX)}`;

/**
 * Notifications (background job results and the like) arrive as JSON. Only the identifying fields survive: kind, state and ids,
 * plus `agent:status` per task. Any other field, including free text from the other side, is dropped.
 */
export function noteText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const record = asRecord(JSON.parse(trimmed));
      if (record) {
        const parts: string[] = [];
        for (const key of ['kind', 'status', 'jobId', 'monitorId', 'exitCode']) {
          const value = record[key];
          if (typeof value === 'string' || num(value) !== undefined) parts.push(`${key}=${oneLine(String(value), 40)}`);
        }
        const tasks = records(record.tasks);
        if (tasks.length) parts.push(`tasks=${tasks.slice(0, 6).map(task => `${str(task.agent) ?? '?'}:${str(task.status) ?? '?'}`).join(',')}`);
        if (parts.length) return parts.join(' ');
      }
    } catch { /* plain text */ }
  }
  return text;
}

/** Conversation only: what was said, no tool calls. Undefined when the item has nothing to say (a tool-call-only turn). */
export function renderL3(item: Item, userMax = DEFAULT_USER_MAX_L3): string | undefined {
  switch (item.kind) {
    case 'user': return item.text.trim() ? `${refText(item.ref)}U: ${userSay(item.text, userMax)}` : undefined;
    case 'assistant': return item.text.trim() ? `${refText(item.ref)}A: ${say(item.text, L3_TEXT_MAX)}` : undefined;
    case 'shell': return shellLine(item);
    case 'note': return item.text.trim() ? noteLine(item) : undefined;
    default: return undefined;
  }
}

/** Recent activity: the same text with a longer limit, and every tool call folded to one line with its result reference. */
export function renderL2(item: Item, userMax = DEFAULT_USER_MAX_L2): string[] {
  switch (item.kind) {
    case 'user': return [`${refText(item.ref)}U: ${userSay(item.text, userMax)}`];
    case 'shell': return [shellLine(item)];
    case 'note': return [noteLine(item)];
    case 'orphan': return [`  ${foldUnpairedResult(item.label ?? 'unknown', item.orphan!)}`];
    default: {
      const calls = item.calls.length;
      const head = item.text.trim() ? say(item.text, L2_TEXT_MAX) : calls ? `→ ${calls} tool call${calls === 1 ? '' : 's'}` : '';
      if (!head && !calls) return [];
      const lines = [`${refText(item.ref)}A: ${head}`.trimEnd()];
      for (const pair of item.calls.slice(0, MAX_CALLS_PER_ITEM)) lines.push(`  ${pair.result ? foldToolUse(pair.call, pair.result) : foldUnpairedCall(pair.call, item.ref)}`);
      if (calls > MAX_CALLS_PER_ITEM) lines.push(`  … +${calls - MAX_CALLS_PER_ITEM} more tool calls`);
      return lines;
    }
  }
}

export const length = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0);
