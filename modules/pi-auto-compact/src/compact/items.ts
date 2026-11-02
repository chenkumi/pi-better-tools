import type { EntryRef } from '../fold/ref.ts';
import type { ToolCallInfo, ToolResultInfo } from '../fold/types.ts';
import { asRecord, list, num, oneLine, redact, str } from '../fold/util.ts';
import { contentText } from '../session-read/outline.ts';

export type Entry = Record<string, unknown>;

/** A tool call with its result; `result` is undefined when none was recorded before the cut. */
export interface CallPair {
  call: ToolCallInfo;
  result?: ToolResultInfo;
}

/**
 * One unit of history that is moved between layers as a whole, so a tool call is never separated from its result.
 * `entryId` and `ref` belong to the unit's first entry.
 */
export interface Item {
  kind: 'user' | 'assistant' | 'shell' | 'note' | 'orphan';
  entryId: string;
  ref?: EntryRef;
  /** User or assistant text, a note, or the shell summary. Thinking is never part of it. */
  text: string;
  /** For a note: its label; for an orphan result: the tool name. */
  label?: string;
  calls: CallPair[];
  /** Result whose call is not in the folded range. */
  orphan?: ToolResultInfo;
}

/** Looks up where an entry lives in the session file (absent when the session is not persisted). */
export type RefLookup = (entryId: string) => EntryRef | undefined;

const imageNote = (count: number) => (count > 0 ? ` [+${count} image${count === 1 ? '' : 's'}]` : '');

/**
 * Applies a context edit the way Pi does when it builds model context: `null` omits the entry, a replacement swaps the
 * content and nothing else. Entries the model never saw must not come back through the summary.
 */
function editedMessage(message: Entry, edit: Entry | undefined): Entry | undefined {
  if (!edit) return message;
  const replacement = asRecord(edit.replacement);
  if (!replacement) return undefined;
  const role = str(message.role);
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return message;
  const content = typeof replacement.content === 'string' && role !== 'user' ? [{ type: 'text', text: replacement.content }] : replacement.content;
  return { ...message, content };
}

function resultInfo(message: Entry, ref: EntryRef | undefined): ToolResultInfo {
  return { text: contentText(message.content).text, details: message.details, isError: message.isError === true, durationMs: num(message.durationMs), ...(ref ? { ref } : {}) };
}

/**
 * Turns the branch entries before the cut into items in file order. Compaction entries are boundary markers, not sources: the
 * summary is always rebuilt from the original entries, so nothing is summarised twice.
 */
export function buildItems(entries: readonly Entry[], refOf: RefLookup): Item[] {
  const edits = new Map<string, Entry>();
  for (const entry of entries) if (entry.type === 'context_edit' && str(entry.targetId)) edits.set(entry.targetId as string, entry);
  const items: Item[] = [];
  const pending = new Map<string, CallPair>();
  for (const entry of entries) {
    const id = str(entry.id);
    if (!id) continue;
    const ref = refOf(id);
    const base = { entryId: id, ...(ref ? { ref } : {}) };
    if (entry.type === 'message') {
      const raw = asRecord(entry.message);
      const message = raw ? editedMessage(raw, edits.get(id)) : undefined;
      if (!message) continue;
      const role = str(message.role);
      if (role === 'user') {
        const { text, images } = contentText(message.content);
        items.push({ ...base, kind: 'user', text: `${text}${imageNote(images)}`, calls: [] });
      } else if (role === 'assistant') {
        const calls: CallPair[] = [];
        for (const block of list(message.content)) {
          const b = asRecord(block);
          if (b?.type !== 'toolCall') continue;
          const pair: CallPair = { call: { id: str(b.id) ?? '', name: str(b.name) ?? 'unknown', args: asRecord(b.arguments) ?? {} } };
          calls.push(pair);
          if (pair.call.id) pending.set(pair.call.id, pair);
        }
        items.push({ ...base, kind: 'assistant', text: contentText(message.content).text, calls });
      } else if (role === 'toolResult') {
        const pair = pending.get(str(message.toolCallId) ?? '');
        if (pair && !pair.result) { pair.result = resultInfo(message, ref); continue; }
        items.push({ ...base, kind: 'orphan', text: '', label: str(message.toolName) ?? 'unknown', calls: [], orphan: resultInfo(message, ref) });
      } else if (role === 'bashExecution' && message.excludeFromContext !== true) {
        const exit = message.cancelled === true ? 'cancelled' : `exit ${num(message.exitCode) ?? '?'}`;
        items.push({ ...base, kind: 'shell', text: `${JSON.stringify(oneLine(redact(str(message.command) ?? ''), 120))} → ${exit}`, calls: [] });
      }
    } else if (entry.type === 'custom_message') {
      items.push({ ...base, kind: 'note', label: str(entry.customType) ?? 'custom', text: contentText(entry.content).text, calls: [] });
    } else if (entry.type === 'branch_summary' && str(entry.summary)) {
      items.push({ ...base, kind: 'note', label: 'branch summary', text: str(entry.summary) as string, calls: [] });
    }
  }
  return items;
}
