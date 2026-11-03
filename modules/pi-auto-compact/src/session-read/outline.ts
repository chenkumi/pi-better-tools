import { formatRef } from '../fold/ref.ts';
import { ANCHOR_TOOL, isCheckpointType } from '../checkpoint/messages.ts';
import { DEFAULT_USER_MAX_L3, L3_TEXT_MAX, userSay } from '../compact/render.ts';
import { asRecord, clip, list, num, oneLine, redact, str } from '../fold/util.ts';

/** One parsed session line. `entry` is undefined when the line was too large to parse. */
export interface LineEntry {
  line: number;
  bytes: number;
  entry?: Record<string, unknown>;
}

/** The outline of one source entry. */
export interface OutlineGroup {
  line: number;
  lines: string[];
}

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

/**
 * Outline of conversation entries, with the same rules as the L3 part of a compaction summary: user and assistant text clipped,
 * the report of a progress checkpoint counted as assistant text, shell commands, notes and compaction boundaries kept, and no tool
 * call or tool result at all (an assistant message that only calls tools shows nothing). Settings-type entries (model, thinking
 * level, labels…) and checkpoint prompts are left out. Look at the details of an entry with session_read, or search tool
 * calls and results with session_grep.
 */
export function projectOutline(items: readonly LineEntry[], firstLine: number, lastLine: number, onBranch?: ReadonlySet<string>): OutlineGroup[] {
  const groups: OutlineGroup[] = [];
  for (const item of items) {
    if (item.line > lastLine) break;
    if (item.line < firstLine) continue;
    if (!item.entry) { groups.push({ line: item.line, lines: [`⟦L${item.line}⟧ [entry too large to outline: ${Math.round(item.bytes / 1024 / 1024)}MB]`] }); continue; }
    const entry = item.entry, type = str(entry.type), message = asRecord(entry.message), mark = branchMark(item, onBranch);
    const head = (label: string, text: string, extra = '') => `${refOf(item)} ${mark}${label}${text ? `: ${clip(oneLine(text, L3_TEXT_MAX), L3_TEXT_MAX)}` : ''}${extra}`;
    if (type === 'message' && message) {
      const role = str(message.role);
      if (role === 'user') { const { text, images: n } = contentText(message.content); groups.push({ line: item.line, lines: [`${refOf(item)} ${mark}user${text ? `: ${userSay(text, DEFAULT_USER_MAX_L3)}` : ''}${images(n)}`] }); }
      else if (role === 'assistant') {
        const reports = list(message.content).map(asRecord).filter((b): b is Record<string, unknown> => b?.type === 'toolCall' && b.name === ANCHOR_TOOL).map(b => str(asRecord(b.arguments)?.summary)).filter((v): v is string => !!v);
        const text = [contentText(message.content).text, ...reports].filter(Boolean).join('\n');
        if (text.trim()) groups.push({ line: item.line, lines: [head('assistant', text)] });
      } else if (role === 'bashExecution') {
        groups.push({ line: item.line, lines: [head('user-shell', `${JSON.stringify(oneLine(redact(str(message.command) ?? ''), 120))} → ${message.cancelled === true ? 'cancelled' : `exit ${num(message.exitCode) ?? '?'}`}`)] });
      }
    } else if (type === 'compaction') {
      groups.push({ line: item.line, lines: [`${refOf(item)} ${mark}── compaction (first kept entry ${str(entry.firstKeptEntryId) ?? '?'}): ${clip(oneLine(str(entry.summary) ?? '', NOTE_MAX), NOTE_MAX)}`] });
    } else if (type === 'branch_summary') {
      groups.push({ line: item.line, lines: [`${refOf(item)} ${mark}── branch summary: ${clip(oneLine(str(entry.summary) ?? '', NOTE_MAX), NOTE_MAX)}`] });
    } else if (type === 'custom_message' && !isCheckpointType(entry.customType)) {
      groups.push({ line: item.line, lines: [head(`[${oneLine(str(entry.customType) ?? 'custom', 40)}]`, clip(contentText(entry.content).text, NOTE_MAX))] });
    } else if (type === 'context_edit') {
      groups.push({ line: item.line, lines: [`${refOf(item)} ${mark}context edit of ${str(entry.targetId) ?? '?'}${entry.replacement === null ? ' (omitted from context)' : ''}`] });
    }
  }
  return groups;
}
