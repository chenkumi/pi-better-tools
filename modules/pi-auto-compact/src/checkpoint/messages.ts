/** Session entry types of the progress checkpoint. They are extension-authored (never typed by the user) and are dropped from summaries and from the model context after a compaction. */
export const CHECKPOINT_TYPE = 'pi-auto-compact:checkpoint';
export const CONTINUE_TYPE = 'pi-auto-compact:continue';
export const isCheckpointType = (type: unknown): boolean => type === CHECKPOINT_TYPE || type === CONTINUE_TYPE;

/** The anchor tool: its `summary` argument is the progress report. For compaction it counts as an assistant text message. */
export const ANCHOR_TOOL = 'progress_checkpoint';

const WHEN = 'Automatic progress checkpoint (not a user request): you have made many tool calls since your last message.';
const WHAT = 'a brief progress report of 2 to 4 sentences: what is done, what is in progress, what is next.';
export const checkpointText = (hasAnchorTool: boolean): string => hasAnchorTool
  ? `${WHEN} Call ${ANCHOR_TOOL} now with ${WHAT} Then continue the task.`
  : `${WHEN} Write ${WHAT} Then continue the task.`;

export const CONTINUE_TEXT = 'Your progress report is recorded. Continue the task if it is unfinished; if it is already complete, reply with one line saying so.';
