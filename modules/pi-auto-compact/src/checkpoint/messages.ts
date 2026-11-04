/** Session entry types of the progress checkpoint. They are extension-authored (never typed by the user) and are dropped from summaries and from the model context after a compaction. */
export const CHECKPOINT_TYPE = 'pi-auto-compact:checkpoint';
export const CONTINUE_TYPE = 'pi-auto-compact:continue';
export const DEADLINE_TYPE = 'pi-auto-compact:deadline';
export const isCheckpointType = (type: unknown): boolean => type === CHECKPOINT_TYPE || type === CONTINUE_TYPE || type === DEADLINE_TYPE;

/** The anchor tool: its `summary` argument is the progress report. For compaction it counts as an assistant text message. */
export const ANCHOR_TOOL = 'progress_checkpoint';

const WHEN = 'Automatic progress checkpoint (not a user request): you have made many tool calls since your last message.';
const WHAT = 'a brief progress report of 2 to 4 sentences: what is done, what is in progress, what is next.';
export const checkpointText = (hasAnchorTool: boolean): string => hasAnchorTool
  ? `${WHEN} Call ${ANCHOR_TOOL} now with ${WHAT} Then continue the task.`
  : `${WHEN} Write ${WHAT} Then continue the task.`;

/** The `note` tool (Note Tools module) creates a notes file and returns its path; later updates are ordinary file edits. */
export const NOTE_TOOL = 'note';
/** Tools through which an agent can write a notes file. */
export const WRITE_TOOLS: readonly string[] = [NOTE_TOOL, 'write', 'edit'];

/** Behavior guidance, not a demand for a tool: the agent decides what to write, and updates a notes file that already exists. */
export const deadlineText = (hasNoteTool: boolean): string =>
  'Automatic notice (not a user request): the context is almost full, and compaction will happen soon. '
  + 'Save your task progress to a notes file now, so you can resume after compaction. '
  + `If a notes file for this task already exists, update it. Otherwise, create one${hasNoteTool ? ` with the ${NOTE_TOOL} tool` : ''}. `
  + 'Record what is done, what is next, and key facts. Mention the file path in your reply. Then continue the task.';

export const CONTINUE_TEXT = 'Continue the task if it is unfinished; if it is already complete, reply with one line saying so.';
