/** Session entry types of the pre-compaction notice. They are extension-authored (never typed by the user) and are dropped from summaries and from the model context after a compaction. */
export const DEADLINE_TYPE = 'pi-auto-compact:deadline';
export const CONTINUE_TYPE = 'pi-auto-compact:continue';
export const isCheckpointType = (type: unknown): boolean => type === DEADLINE_TYPE || type === CONTINUE_TYPE;

/** The checkpoint tool: its `summary` argument is the progress snapshot. It lives in the conversation (the tool call), never in a file. */
import { PROGRESS_CHECKPOINT_TOOL } from '../../../../shared/src/contracts/index.ts';
export const CHECKPOINT_TOOL = PROGRESS_CHECKPOINT_TOOL;

/** Behavior guidance, not a forced call: the agent decides what to write. The summary of a compaction shows the latest checkpoint in full. */
export const deadlineText = (): string =>
  'Automatic notice (not a user request): the context is almost full, and compaction will happen soon. '
  + `Save your task progress now by calling ${CHECKPOINT_TOOL}, so you can resume after compaction. `
  + 'Your very next action must be that call: do not read files or think at length first, everything you need is already in this conversation. '
  + 'In `summary` write what is done, what is next, and the key facts (decisions, file paths, commands, open problems), enough to continue without the earlier messages; leave out what is not needed to resume. Then continue the task.';

export const CONTINUE_TEXT = 'Continue the task if it is unfinished; if it is already complete, reply with one line saying so.';
