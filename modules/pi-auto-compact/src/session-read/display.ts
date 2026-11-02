import { Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

/** Terminal-safe, bounded text for display only (the model-facing result is never changed by a renderer). */
export const displayText = (value: unknown, max = 2000): string => typeof value === 'string'
  ? stripVTControlCharacters(value.slice(0, max * 4)).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').slice(0, max)
  : '';

interface ThemeLike { fg(color: string, text: string): string; bold(text: string): string }
interface RenderContext { isError: boolean; lastComponent?: unknown }
interface ResultLike { content: Array<{ type: string; text?: string }>; details?: unknown }

export interface SessionToolDisplay {
  /** Tool title shown on the call line. */
  title: string;
  /** Short description of the call arguments, e.g. `L1234–1240`. */
  call: (args: Record<string, unknown>) => string;
  /** Short description of a finished result from its details, e.g. `3 lines, 1.2k chars`. */
  result: (details: Record<string, unknown>) => string;
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' ? value as Record<string, unknown> : {});

/** renderCall/renderResult for the session tools. Compact view shows where and how much; the expanded view adds the text. */
export function sessionToolRenderers(display: SessionToolDisplay) {
  const reuse = (context: RenderContext) => (context.lastComponent instanceof Text ? context.lastComponent : new Text('', 0, 0));
  return {
    renderCall(args: Record<string, unknown> | undefined, theme: ThemeLike, context: RenderContext) {
      const component = reuse(context);
      component.setText(`${theme.fg('toolTitle', theme.bold(display.title))} ${theme.fg('accent', displayText(display.call(record(args)), 200) || '…')}`);
      return component;
    },
    renderResult(result: ResultLike, options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: RenderContext) {
      const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
      if (context.isError) return new Text(theme.fg('error', `${display.title} failed\n${displayText(text, 800)}`), 0, 0);
      if (options.isPartial) return new Text(theme.fg('muted', `${display.title}…`), 0, 0);
      const summary = displayText(display.result(record(result.details)), 200) || 'done';
      return new Text(theme.fg('success', summary) + (options.expanded ? `\n${displayText(text, 4000)}` : ''), 0, 0);
    },
  };
}
