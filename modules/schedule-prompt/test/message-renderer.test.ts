import { describe, expect, it } from 'vitest';
import { stripVTControlCharacters as stripAnsi } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderScheduledMessage } from '../src/ui/message-renderer.js';
const backgrounds: Record<string, string> = { toolSuccessBg: '\x1b[48;5;22m', toolErrorBg: '\x1b[48;5;52m', toolPendingBg: '\x1b[48;5;58m' };
const theme = { fg: (_: string, text: string) => `\x1b[32m${text}\x1b[0m`, getBgAnsi: (key: string) => backgrounds[key], bg: (key: string, text: string) => backgrounds[key] + text + '\x1b[49m' } as any;
function show(details: any, expanded = false, content: any = 'model content unchanged') {
  const message = { role: 'custom', customType: 'scheduled_prompt', content, details } as any;
  const before = JSON.stringify(message);
  const component = renderScheduledMessage(message, { expanded, outputPad: 0 }, theme)!;
  let text = '';
  for (const width of [0, 1, 2, 3, 4, 5, 6, 12, 24, 80]) {
    const lines = component.render(width);
    expect(lines.length).toBeLessThanOrEqual(300);
    const bg = lines[0].match(/^\x1b\[48;5;(22|52|58)m/)![0];
    expect(stripAnsi(lines[0])).toBe(' '.repeat(width)); expect(stripAnsi(lines.at(-1)!)).toBe(' '.repeat(width));
    for (const line of lines) {
      expect(line.startsWith(bg) && line.endsWith('\x1b[49m')).toBe(true);
      expect(visibleWidth(line)).toBe(width);
      for (const reset of line.matchAll(/\x1b\[(?:0)?m/g)) expect(line.startsWith(bg, reset.index! + reset[0].length)).toBe(true);
    }
    for (const line of lines) { expect(visibleWidth(line)).toBeLessThanOrEqual(width); expect(line).not.toMatch(/[\n\r]/); }
    // SGR reset/style from TUI is valid; OSC, cursor and other controls are not.
    expect(lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    if (width === 80) text = stripAnsi(lines.join('\n'));
  }
  component.invalidate();
  expect(JSON.stringify(message)).toBe(before);
  return text;
}
describe('scheduled completion messages', () => {
  it.each([['subagent_start', 'starting'], ['subagent_done', 'finished'], ['subagent_error', 'failed'], [undefined, 'delivered (not completed)']])('renders %s independently of output words', (mode, expected) => {
    const text = show({ mode, jobName: '測試😀', jobId: 'j', prompt: 'original prompt', model: 'offline', output: 'Error: expected test\nsecond\nthird\nfourth', error: 'failure' });
    expect(text).toContain(expected);
    if (mode === 'subagent_done') { expect(text).toContain('✓'); expect(text).not.toContain('fourth'); }
    const expanded = show({ mode, jobName: 'n', jobId: 'j', prompt: 'original prompt', output: 'first\nsecond\nthird\nfourth' }, true);
    expect(expanded).toContain('Job: j'); expect(expanded).toContain('original prompt');
    if (mode !== 'subagent_error') expect(expanded).toContain('fourth');
  });
  it('legacy messages without details retain sanitized content on collapse and expand', () => {
    const content = [{ type: 'text', text: '\x1b[2Jold first\nsecond\nthird\nfourth\u202e' }];
    const collapsed = show(undefined, false, content);
    expect(collapsed).toContain('status unknown'); expect(collapsed).toContain('old first'); expect(collapsed).not.toContain('fourth');
    expect(show(undefined, true, content)).toContain('fourth');
    expect(show(null, true, [null, {}, { type: 'text' }])).toContain('Unknown');
  });
  it('empty finished results are explicit rather than repeating the prompt', () => {
    const text = show({ mode: 'subagent_done', prompt: 'original request', output: '' });
    expect(text).toContain('No result retained'); expect(text).not.toContain('original request');
  });
  it('shows skipped setup as warning, including the precise historical reason', () => {
    const historical = 'Skipped: deadline reached or job unavailable before prompt start';
    expect(show({ mode: 'subagent_done', skipped: true, output: historical })).toContain('! Scheduled skipped');
    expect(show({ mode: 'subagent_done', output: historical })).toContain('! Scheduled skipped');
    expect(show({ mode: 'subagent_done', output: 'Skipped: model chose to skip a check' })).toContain('✓ Scheduled finished');
  });
  it('uses native tool backgrounds without claiming skipped or delivered work completed', () => {
    for (const [details, token] of [[{ mode: 'subagent_done' }, 'toolSuccessBg'], [{ mode: 'subagent_error' }, 'toolErrorBg'], [{ mode: 'subagent_start' }, 'toolPendingBg'], [{ mode: 'subagent_done', skipped: true }, 'toolPendingBg'], [{ mode: 'subagent_error', skipped: true }, 'toolPendingBg'], [{ prompt: 'inline' }, 'toolPendingBg'], [undefined, 'toolPendingBg']] as const) {
      const component = renderScheduledMessage({ content: 'Error: expected test', details } as any, { expanded: false, outputPad: 0 }, theme)!;
      expect(component.render(24)[0].startsWith(backgrounds[token])).toBe(true);
    }
  });
  it('sanitizes every untrusted field, handles invalid details and caps long results', () => {
    const unsafe = '\x1b]0;title\x07\x1b[2J\u202e測試😀';
    const text = show({ mode: 'subagent_error', jobName: unsafe, jobId: unsafe, model: unsafe, prompt: unsafe, error: unsafe }, true);
    expect(text).toContain('測試😀');
    expect(show(null)).toContain('Unknown');
    expect(show({ mode: 'subagent_done', output: '界😀\n'.repeat(30000) }, true)).toContain('Display limit');
  });
});
