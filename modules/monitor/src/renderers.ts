import { Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
const clean = (value: string) => stripVTControlCharacters(value.slice(0, 8192)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
class BoundedText extends Text { override render(width: number) { return super.render(width).slice(0, 100); } }
export function monitorRenderers(action: string): Pick<ToolDefinition, 'renderCall' | 'renderResult'> {
  return {
    renderCall(args, theme) { const id = (args as { monitorId?: unknown } | undefined)?.monitorId; return new BoundedText(theme.fg('toolTitle', `Monitor ${action}${typeof id === 'string' ? ' ' + clean(id.slice(0, 128)) : ''}`), 0, 0); },
    renderResult(result, options, theme) {
      const value: any = result.details;
      const text = result.content.filter(p => p.type === 'text').map(p => p.text.slice(0, 8192)).join('\n').slice(0, 8192);
      const summary = typeof value?.monitorId === 'string' ? `Monitor ${clean(value.monitorId)} · ${clean(value.state ?? 'unknown')}\n${value.cleanupEvidence?.sourceClosed === true ? 'Source close observed; descendant state unknown.' : 'Source close not confirmed; cleanup evidence unknown.'}\nSubmission: ${clean(value.notification?.state ?? 'unknown')} (no host acknowledgment)` : text;
      return new BoundedText(theme.fg('toolOutput', clean(options.expanded ? text : summary)), 0, 0);
    },
  };
}
