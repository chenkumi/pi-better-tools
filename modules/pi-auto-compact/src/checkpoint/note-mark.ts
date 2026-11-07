import { asRecord, clip, oneLine, str } from '../fold/util.ts';
import { NOTE_TOOL } from './messages.ts';

/** `note` type that marks a task segment: a progress snapshot saved by the agent (usually on the deadline notice). */
export const NOTE_CHECKPOINT_TYPE = 'checkpoint';
const TITLE_MAX = 80;

/** True for a call of the note tool that saves a checkpoint. */
export const isCheckpointNoteCall = (name: unknown, args: unknown): boolean => name === NOTE_TOOL && asRecord(args)?.type === NOTE_CHECKPOINT_TYPE;

/** First non-empty line of the note without heading marks, clipped; empty when the note has no text. */
export function checkpointTitle(args: unknown): string {
  const line = (str(asRecord(args)?.content) ?? '').split('\n').find(text => text.trim() !== '') ?? '';
  return clip(oneLine(line.replace(/^\s*#+\s*/, ''), TITLE_MAX), TITLE_MAX);
}

/** The saved path from a successful note result's details, only when it is a checkpoint note (the folder is `checkpoints/`). */
export function checkpointPath(details: unknown): string | undefined {
  const path = str(asRecord(details)?.relativePath);
  return path?.startsWith('checkpoints/') ? path : undefined;
}

/** `checkpoint: <path> — <title>`: what stays of a checkpoint note in the conversation-only layers. */
export const checkpointMark = (path: string, title: string): string => `checkpoint: ${path}${title ? ` — ${title}` : ''}`;
