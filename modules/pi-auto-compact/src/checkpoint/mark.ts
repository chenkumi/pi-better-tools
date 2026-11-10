import { asRecord, clip, list, oneLine, str } from '../fold/util.ts';
import { CHECKPOINT_TOOL } from './messages.ts';

const TITLE_MAX = 80;

/** True for a call of the checkpoint tool. */
export const isCheckpointCall = (name: unknown): boolean => name === CHECKPOINT_TOOL;

/** The snapshot text of a checkpoint call (its `summary` argument); empty when the call has none. */
export const checkpointBody = (args: unknown): string => str(asRecord(args)?.summary) ?? '';

/** First non-empty line of the snapshot without heading marks, clipped; empty when it has no text. */
export function checkpointTitle(args: unknown): string {
  const line = checkpointBody(args).split('\n').find(text => text.trim() !== '') ?? '';
  return clip(oneLine(line.replace(/^\s*#+\s*/, ''), TITLE_MAX), TITLE_MAX);
}

/** `checkpoint: <title>`: what stays of a checkpoint in the conversation-only layers (the full text is in the call, reachable through the entry reference). */
export const checkpointMark = (title: string): string => `checkpoint${title ? `: ${title}` : ''}`;

/** True when the entries hold a checkpoint call that completed: an assistant message calls the tool and a non-error tool result answers that call id. */
export function hasSavedCheckpoint(entries: readonly Record<string, unknown>[]): boolean {
  const called = new Set<string>();
  const saved = new Set<string>();
  for (const entry of entries) {
    const message = entry.type === 'message' ? asRecord(entry.message) : undefined;
    if (message?.role === 'assistant') {
      for (const block of list(message.content)) {
        const b = asRecord(block), id = str(b?.id);
        if (id && b?.type === 'toolCall' && isCheckpointCall(b.name) && checkpointBody(b.arguments).trim() !== '') called.add(id);
      }
    } else if (message?.role === 'toolResult' && message.isError !== true) {
      const id = str(message.toolCallId);
      if (id) saved.add(id);
    }
  }
  for (const id of called) if (saved.has(id)) return true;
  return false;
}
