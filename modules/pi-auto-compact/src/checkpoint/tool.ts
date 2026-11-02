import { defineTool } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { displayText } from '../session-read/display.ts';
import { ANCHOR_TOOL } from './messages.ts';

/**
 * The anchor tool. Its only effect is to be part of the conversation: a tool call always returns to the model, so reporting
 * progress this way can never end the run the way a plain text answer can, and compaction reads `summary` as an assistant message.
 */
export const progressCheckpointTool = defineTool({
  name: ANCHOR_TOOL,
  label: 'Progress checkpoint',
  description: 'Record a brief progress report (what is done, what is in progress, what is next) during a long task, then keep working. Call it when asked to report progress, or after a long stretch of tool calls.',
  promptSnippet: 'Record a brief progress report during a long task and keep working',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  defaultActive: true,
  parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 1500, description: 'Two to four sentences: what is done, what is in progress, what is next.' }) }, { additionalProperties: false }),
  async execute() {
    return { content: [{ type: 'text' as const, text: 'Progress recorded. Continue the task.' }], details: {} };
  },
  renderCall(args, theme, context) {
    const component = context.lastComponent instanceof Text ? context.lastComponent : new Text('', 0, 0);
    component.setText(`${theme.fg('toolTitle', theme.bold('Progress checkpoint'))}\n${theme.fg('muted', displayText((args as { summary?: unknown })?.summary, 600))}`);
    return component;
  },
  renderResult(_result, _options, theme) { return new Text(theme.fg('success', 'recorded'), 0, 0); },
});
