// Spike: one global registerToolRenderer resolver that gives EVERY tool (builtin, project, third-party FFF) the TUI_DESIGN.md look:
// no background box (renderShell "self"), collapsed = two lines, expanded = call line + body + collapse hint.
// Also an offline provider that calls read, grep and bash in turn.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

const SUMMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'task', 'title', 'name'];
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
const textOf = (result: any): string => (Array.isArray(result?.content) ? result.content : []).map((c: any) => c?.text ?? '').join('\n');

function callSummary(name: string, args: any): string {
  if (!args || typeof args !== 'object') return '';
  for (const key of SUMMARY_KEYS) if (typeof args[key] === 'string' && args[key]) return args[key].split('\n')[0];
  const first = Object.values(args).find(v => typeof v === 'string');
  return typeof first === 'string' ? first : '';
}

/** Left text, right hint on the same row (hint dropped when it does not fit). */
function rowWithHint(left: string, hint: string, width: number): string {
  const room = width - visibleWidth(left) - 2 - visibleWidth(hint);
  if (room < 0) return truncateToWidth(left, width, '...');
  return left + ' '.repeat(room + 2) + hint;
}

export default function (pi: ExtensionAPI) {
  if (!process.env.SPIKE_NO_RENDERER) pi.registerToolRenderer((toolName) => ({
    renderShell: 'self',
    renderCall(args: any, theme: any, context: any) {
      const title = `${theme.fg(context.isError ? 'error' : context.isPartial ? 'warning' : 'success', '●')} ${theme.bold(theme.fg('toolTitle', toolName))} ${theme.fg('muted', callSummary(toolName, args))}`;
      return { invalidate() {}, render: (width: number) => ['', truncateToWidth(title, width, '…')] };
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) {
      const body = strip(textOf(result)).replace(/\r/g, '');
      const lines = body.split('\n').filter((line, i, all) => line.trim() || i < all.length - 1);
      const first = lines.find(line => line.trim()) ?? '(no output)';
      const took = context.durationMs === undefined ? '' : ` · took ${(context.durationMs / 1000).toFixed(1)}s`;
      return {
        invalidate() {},
        render: (width: number) => {
          if (options.isPartial) return [`   ${theme.fg('dim', 'running…')}`];
          if (!options.expanded) {
            const summary = `${first}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ''}${took}`;
            return [rowWithHint(`   ${theme.fg(context.isError ? 'error' : 'dim', truncateToWidth(summary, Math.max(10, width - 24), '…'))}`, theme.fg('dim', '[Click to expand]'), width)];
          }
          const out = [''];
          for (const line of lines.slice(0, 40)) out.push(`   ${theme.fg('border', '▌')} ${truncateToWidth(line, Math.max(1, width - 6), '…')}`);
          if (lines.length > 40) out.push(`   ${theme.fg('dim', `… ${lines.length - 40} more lines`)}`);
          out.push('', rowWithHint(`   ${theme.fg('dim', took.replace(/^ · /, '') || 'done')}`, theme.fg('dim', '[Click to Collapse]'), width));
          return out;
        },
      };
    },
  }));

  // ---- offline provider: read, grep, bash, then a text answer
  const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const script = process.env.SPIKE_SCRIPT ? JSON.parse(process.env.SPIKE_SCRIPT) : [
    { name: 'read', args: { path: 'sample.txt' } },
    { name: 'grep', args: { pattern: 'needle' } },
    { name: 'bash', args: { command: 'echo hello from bash && echo second line' } },
    { name: 'write', args: { path: 'out.txt', content: 'hello world' } },
    { name: 'bash', args: { command: 'echo oops >&2; exit 3', timeoutMs: 20000 } },
  ];
  pi.registerProvider('spike', { baseUrl: 'http://127.0.0.1:1/never', apiKey: 'dummy', api: 'spike-api',
    models: [{ id: 'fixture', name: 'Spike', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const results = context.messages.filter((m: any) => m.role === 'toolResult').length;
      const step = script[results];
      const message: any = { role: 'assistant', provider: model.provider, api: model.api, model: model.id, content: [], stopReason: step ? 'toolUse' : 'stop', usage: usage(), timestamp: Date.now() };
      setImmediate(() => {
        stream.push({ type: 'start', partial: message });
        if (step) {
          message.content = [{ type: 'toolCall', id: `call-${results}`, name: step.name, arguments: step.args }];
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message });
          stream.push({ type: 'done', reason: 'toolUse', message });
        } else {
          message.content = [{ type: 'text', text: 'all tools done' }];
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: 'all tools done', partial: message });
          stream.push({ type: 'done', reason: 'stop', message });
        }
        stream.end();
      });
      return stream;
    } });
}
