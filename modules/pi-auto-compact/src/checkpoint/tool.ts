import { defineTool } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { displayText } from '../session-read/display.ts';
import { CHECKPOINT_TOOL } from './messages.ts';

/**
 * The checkpoint tool. It writes nothing: the snapshot is the call's `summary` argument, which stays in the conversation. A
 * compaction shows the latest checkpoint in full and the older ones as one titled line each, and `session_read` returns the original.
 */
export const progressCheckpointTool = defineTool({
  name: CHECKPOINT_TOOL,
  label: 'Progress checkpoint',
  description: 'Save a progress checkpoint: everything needed to resume the task if the context is compacted (the goal, what is done, what is next, key facts such as decisions, file paths, commands and open problems). It is kept in the conversation, not in a file. Call it when an automatic notice asks for it, or at a natural milestone of a long task, then keep working.',
  promptSnippet: 'Save a progress checkpoint (done / next / key facts) in the conversation and keep working',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  defaultActive: true,
  parameters: Type.Object({ summary: Type.String({ minLength: 1, description: 'The checkpoint: what is done, what is next and the key facts, enough to continue without the earlier messages. The first line is its title.' }) }, { additionalProperties: false }),
  async execute() {
    return { content: [{ type: 'text' as const, text: 'Checkpoint saved. Continue the task.' }], details: {} };
  },
  renderCall(args, theme, context) {
    const component = context.lastComponent instanceof Text ? context.lastComponent : new Text('', 0, 0);
    component.setText(`${theme.fg('toolTitle', theme.bold('Progress checkpoint'))}\n${theme.fg('muted', displayText((args as { summary?: unknown })?.summary, 600))}`);
    return component;
  },
  renderResult(_result, _options, theme) { return new Text(theme.fg('success', 'saved'), 0, 0); },
});
