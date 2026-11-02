import { formatRef } from '../fold/ref.ts';
import { foldToolUse, foldUnpairedCall, foldUnpairedResult } from '../fold/registry.ts';
import type { ToolCallInfo, ToolResultInfo } from '../fold/types.ts';
import { asRecord, clip, list, num, oneLine, redact, str } from '../fold/util.ts';

/** One parsed session line. `entry` is undefined when the line was too large to parse. */
export interface LineEntry {
  line: number;
  bytes: number;
  entry?: Record<string, unknown>;
}

/** The outline of one source entry: its own line plus the folded tool calls it contains. */
export interface OutlineGroup {
  line: number;
  lines: string[];
}

const TEXT_MAX = 300;
const NOTE_MAX = 160;

export function contentText(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  const parts: string[] = [];
  let images = 0;
  for (const block of list(content)) {
    const b = asRecord(block);
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b?.type === 'image') images++;
  }
  return { text: parts.join('\n'), images };
}

const refOf = (item: LineEntry) => formatRef({ line: item.line, id: str(item.entry?.id) ?? '?', bytes: item.bytes });
const images = (count: number) => (count > 0 ? ` [+${count} image${count === 1 ? '' : 's'}]` : '');
const branchMark = (item: LineEntry, onBranch: ReadonlySet<string> | undefined) => (onBranch && item.entry && !onBranch.has(str(item.entry.id) ?? '') ? '(other branch) ' : '');

function resultInfo(item: LineEntry, message: Record<string, unknown>): ToolResultInfo {
  const { text } = contentText(message.content);
  return { text, details: message.details, isError: message.isError === true, durationMs: num(message.durationMs), ref: { line: item.line, id: str(item.entry?.id) ?? '?', bytes: item.bytes } };
}

/**
 * Outline of conversation entries: user and assistant text clipped, each tool call folded to one line with the line reference
 * of its result, compaction boundaries marked. Settings-type entries (model, thinking level, labels…) are left out.
 * Only entries from `firstLine` to `lastLine` are emitted, but calls and results are looked up in all of `items`: a call near
 * the end of the range finds its result just past it, and a result near the start finds its call just before it.
 */
export function projectOutline(items: readonly LineEntry[], firstLine: number, lastLine: number, onBranch?: ReadonlySet<string>): OutlineGroup[] {
  const results = new Map<string, LineEntry>();
  const calls = new Map<string, ToolCallInfo>();
  const shownCalls = new Set<string>();
  for (const item of items) {
    const message = asRecord(item.entry?.message);
    if (message?.role === 'toolResult' && str(message.toolCallId)) results.set(message.toolCallId as string, item);
    if (message?.role === 'assistant') {
      for (const block of list(message.content)) {
        const b = asRecord(block);
        if (b?.type !== 'toolCall' || !str(b.id)) continue;
        calls.set(b.id as string, { id: b.id as string, name: str(b.name) ?? 'unknown', args: asRecord(b.arguments) ?? {} });
        if (item.line >= firstLine && item.line <= lastLine) shownCalls.add(b.id as string);
      }
    }
  }
  const groups: OutlineGroup[] = [];
  for (const item of items) {
    if (item.line > lastLine) break;
    if (item.line < firstLine) continue;
    if (!item.entry) { groups.push({ line: item.line, lines: [`⟦L${item.line}⟧ [entry too large to outline: ${Math.round(item.bytes / 1024 / 1024)}MB]`] }); continue; }
    const entry = item.entry, type = str(entry.type), message = asRecord(entry.message), mark = branchMark(item, onBranch);
    const head = (label: string, text: string, extra = '') => `${refOf(item)} ${mark}${label}${text ? `: ${clip(oneLine(text, TEXT_MAX), TEXT_MAX)}` : ''}${extra}`;
    if (type === 'message' && message) {
      const role = str(message.role);
      if (role === 'user') { const { text, images: n } = contentText(message.content); groups.push({ line: item.line, lines: [head('user', text, images(n))] }); }
      else if (role === 'assistant') {
        const { text } = contentText(message.content);
        const calls = list(message.content).map(asRecord).filter((b): b is Record<string, unknown> => b?.type === 'toolCall');
        const lines = [head('assistant', text, !text && calls.length ? ` → ${calls.length} tool call${calls.length === 1 ? '' : 's'}` : '')];
        for (const call of calls) {
          const info = { id: str(call.id) ?? '', name: str(call.name) ?? 'unknown', args: asRecord(call.arguments) ?? {} };
          const found = results.get(info.id);
          const resultMessage = asRecord(found?.entry?.message);
          if (found && resultMessage) lines.push(`  ${foldToolUse(info, resultInfo(found, resultMessage))}`);
          else lines.push(`  ${foldUnpairedCall(info, { line: item.line, id: str(entry.id) ?? '?' })}`);
        }
        groups.push({ line: item.line, lines });
      } else if (role === 'toolResult') {
        const callId = str(message.toolCallId) ?? '', call = calls.get(callId);
        if (shownCalls.has(callId)) continue;
        // The call is before the range: its arguments are known, so the result is folded like a paired one.
        groups.push({ line: item.line, lines: [`  ${call ? foldToolUse(call, resultInfo(item, message)) : foldUnpairedResult(str(message.toolName) ?? 'unknown', resultInfo(item, message))}`] });
      } else if (role === 'bashExecution') {
        groups.push({ line: item.line, lines: [head('user-shell', `${JSON.stringify(oneLine(redact(str(message.command) ?? ''), 120))} → ${message.cancelled === true ? 'cancelled' : `exit ${num(message.exitCode) ?? '?'}`}`)] });
      } else groups.push({ line: item.line, lines: [head(role ?? 'message', contentText(message.content).text)] });
    } else if (type === 'compaction') {
      groups.push({ line: item.line, lines: [`${refOf(item)} ${mark}── compaction (first kept entry ${str(entry.firstKeptEntryId) ?? '?'}): ${clip(oneLine(str(entry.summary) ?? '', NOTE_MAX), NOTE_MAX)}`] });
    } else if (type === 'branch_summary') {
      groups.push({ line: item.line, lines: [`${refOf(item)} ${mark}── branch summary: ${clip(oneLine(str(entry.summary) ?? '', NOTE_MAX), NOTE_MAX)}`] });
    } else if (type === 'custom_message') {
      groups.push({ line: item.line, lines: [head(`[${oneLine(str(entry.customType) ?? 'custom', 40)}]`, clip(contentText(entry.content).text, NOTE_MAX))] });
    } else if (type === 'context_edit') {
      groups.push({ line: item.line, lines: [`${refOf(item)} ${mark}context edit of ${str(entry.targetId) ?? '?'}${entry.replacement === null ? ' (omitted from context)' : ''}`] });
    }
  }
  return groups;
}
