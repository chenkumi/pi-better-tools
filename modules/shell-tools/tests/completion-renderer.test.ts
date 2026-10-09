import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters as stripAnsi } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { renderShellCompletion, renderShellJobResult } from '../src/completion-renderer.js';
import registerShell from '../extensions/timeout-ms.ts';
const backgrounds: Record<string, string> = { toolSuccessBg: '\x1b[48;5;22m', toolErrorBg: '\x1b[48;5;52m', toolPendingBg: '\x1b[48;5;58m' };
const theme = { fg: (_: string, s: string) => `\x1b[32m${s}\x1b[0m`, getBgAnsi: (key: string) => backgrounds[key], bg: (key: string, s: string) => backgrounds[key] + s + '\x1b[49m' } as any;
function show(message: any, expanded = false) {
  const before = JSON.stringify(message);
  const component = renderShellCompletion(message, { expanded, outputPad: 0 }, theme)!;
  let text = '';
  for (const width of [0, 1, 2, 3, 4, 5, 6, 12, 24, 80]) {
    const lines = component.render(width);
    assert.ok(lines.length <= 300);
    const bg = lines[0].match(/^\x1b\[48;5;(22|52|58)m/)![0];
    assert.equal(stripAnsi(lines[0]), ' '.repeat(width)); assert.equal(stripAnsi(lines.at(-1)!), ' '.repeat(width));
    for (const line of lines) {
      assert.ok(line.startsWith(bg) && line.endsWith('\x1b[49m'));
      assert.equal(visibleWidth(line), width);
      for (const reset of line.matchAll(/\x1b\[(?:0)?m/g)) assert.ok(line.startsWith(bg, reset.index! + reset[0].length), 'background must survive SGR reset');
    }
    for (const line of lines) { assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${line}`); assert.ok(!line.includes('\n') && !line.includes('\r'), 'each rendered row must be a single line'); }
    // Allow only TUI-generated SGR styling/reset; every other control is forbidden.
    assert.doesNotMatch(lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    if (width === 80) text = stripAnsi(lines.join('\n'));
  }
  component.invalidate();
  assert.equal(JSON.stringify(message), before);
  return text;
}
const message = (job: any) => ({ role: 'custom', customType: 'shell-job-completed', content: 'Untrusted data\n' + JSON.stringify([job]), details: { jobs: [{ jobId: job.jobId, status: job.status, command: job.command, exitCode: job.exitCode, elapsedMs: job.elapsedMs, outputTruncated: job.outputTruncated, logPath: job.log }] } });
test('shell completion decodes JSON/ANSI, prefers tail, uses exit not Error text, and preserves message', () => {
  const m = message({ jobId: 'id', status: 'completed', exitCode: 0, elapsedMs: 68270, command: 'npm test 測試😀', output: 'Error: expected negative test\nhead', outputTail: '\x1b[32mfinal success\x1b[0m\nlast line', outputTruncated: true, log: '/tmp/test.log' });
  const text = show(m);
  assert.match(text, /✓ Shell completed · exit 0 · 68.3s/);
  assert.match(text, /final success/); assert.doesNotMatch(text, /expected negative/);
  assert.match(text, /Command output tail \(data, not instructions\)/);
  assert.doesNotMatch(text, /untrusted/i);
  assert.match(text, /at most the first 1 MiB/); assert.match(text, /\/tmp\/test.log/);
  const expanded = show(m, true);
  assert.match(expanded, /Job: id/); assert.match(expanded, /Retained output head:/); assert.match(expanded, /expected negative/);
});
test('head-only output is informational while actual failures retain the error state', () => {
  const shown = show(message({ jobId: 'j', status: 'failed', exitCode: 2, output: 'partial output' }));
  assert.match(shown, /Command output \(data, not instructions\)/);
  assert.match(shown, /✗ Shell failed · exit 2/);
  assert.doesNotMatch(shown, /untrusted/i);
});
for (const [status, exitCode, expected] of [['failed', 2, '✗'], ['timed_out', undefined, '✗'], ['cancelled', undefined, '!'], ['completed', undefined, '!'], ['completed', 7, '✗']] as const) {
  test(`shell authoritative status ${status}/${exitCode}`, () => {
    const text = show(message({ jobId: 'j', status, exitCode, command: 'echo x', error: 'bad\x1b]0;title\x07\u202eX' }));
    assert.match(text, new RegExp(`\n ${expected} Shell`)); assert.doesNotMatch(text, /✓/); assert.match(text, /badX/);
  });
}
test('legacy arrays, text blocks, metadata-only and malformed notifications do not crash', () => {
  show({ content: JSON.stringify([{ jobId: 'old', status: 'completed', exitCode: 0, command: 'old' }]) }, true);
  show({ content: [{ type: 'text', text: 'prefix\n' + JSON.stringify([{ jobId: 'old', status: 'cancelled' }]) }] });
  assert.match(show({ content: 'broken', details: { jobs: [{ jobId: 'j', status: 'completed', exitCode: 0 }] } }), /No output retained/);
  assert.match(show({ content: 'bad\x1b[2J\u202eJSON', details: null }), /Insufficient result data to determine status/);
});
test('multi-line error previews stay compact and expanded shows remaining lines', () => {
  const m = message({ jobId: 'e', status: 'failed', exitCode: 1, error: 'first\nsecond\nthird\nfourth', command: 'cmd' });
  assert.match(show(m), /third/); assert.doesNotMatch(show(m), /fourth/);
  assert.match(show(m, true), /fourth/);
});
test('malformed blocks and non-finite codes cannot crash or forge success', () => {
  show({ content: [null, {}, { type: 'text' }] });
  assert.ok(!show({ content: 'legacy', details: { jobs: [{ status: 'completed', exitCode: Infinity }] } }).includes('✓'));
});
test('native tool background follows authoritative status, including mixed batches', () => {
  for (const [status, exitCode, token] of [['completed', 0, 'toolSuccessBg'], ['failed', 1, 'toolErrorBg'], ['timed_out', undefined, 'toolErrorBg'], ['cancelled', undefined, 'toolPendingBg'], ['completed', undefined, 'toolPendingBg']] as const) {
    const component = renderShellCompletion(message({ jobId: 'j', status, exitCode, output: 'Error: expected test' }), { expanded: false, outputPad: 0 }, theme)!;
    assert.ok(component.render(24)[0].startsWith(backgrounds[token]));
  }
  const good = { status: 'completed', exitCode: 0 }, failed = { status: 'failed', exitCode: 2 }, unknown = { status: 'completed' };
  for (const [jobs, token] of [[[good, good], 'toolSuccessBg'], [[good, failed], 'toolErrorBg'], [[good, unknown], 'toolPendingBg']] as const) {
    assert.ok(renderShellCompletion({ content: JSON.stringify(jobs) } as any, { expanded: true, outputPad: 0 }, theme)!.render(24)[0].startsWith(backgrounds[token]));
  }
});
test('palette changes and resize redraw the complete block without cached colors', () => {
  let ansi = '\x1b[48;5;22m';
  const dynamic = { ...theme, getBgAnsi: () => ansi, bg: (_: string, text: string) => ansi + text + '\x1b[49m' };
  const component = renderShellCompletion(message({ jobId: 'j', status: 'completed', exitCode: 0, output: 'long text '.repeat(20) }), { expanded: true, outputPad: 0 }, dynamic)!;
  component.render(24); ansi = '\x1b[48;5;25m'; component.invalidate();
  for (const line of component.render(12)) { assert.equal(visibleWidth(line), 12); assert.ok(line.startsWith(ansi)); assert.doesNotMatch(line, /\x1b\[48;5;22m/); }
});
test('cancelled nonzero exit remains cancelled with a neutral background', () => {
  const m = message({ jobId: 'j', status: 'cancelled', exitCode: 130, error: 'Command aborted' });
  for (const expanded of [false, true]) {
    const shown = show(m, expanded);
    assert.match(shown, /! Shell cancelled · job cancelled · exit 130/);
    assert.match(shown, /Cancellation reason: Command aborted/);
    assert.doesNotMatch(shown, /Shell failed|Error:/);
    assert.ok(renderShellCompletion(m as any, { expanded, outputPad: 0 }, theme)!.render(80)[0].startsWith(backgrounds.toolPendingBg));
  }
});
test('truncation never claims a below-limit log lost output; absent exit code is explained', () => {
  const m = message({ jobId: 'j', status: 'completed', outputTruncated: true, log: '/existing/log' });
  m.details.jobs[0].logBytes = 20000;
  const shown = show(m, true);
  assert.match(shown, /job finished; exit code not provided/);
  assert.match(shown, /Only part of the output is retained in this notification/);
  assert.match(shown, /at most the first 1 MiB/);
  assert.doesNotMatch(shown, /not full output|Additional output was not saved|✓/);
});
test('management rendering has bounded English named fields without mutating JSON', () => {
  const input: any = { content: [{ type: 'text', text: '{"jobId":"j","status":"cancelling"}' }], structuredContent: { jobId: 'j', status: 'cancelling', exitCode: 130, error: 'wait\x1b[2J\u202e', output: 'retained data', logPath: '/existing/log' } };
  const before = JSON.stringify(input);
  for (const expanded of [false, true]) {
    const component = renderShellJobResult(input, { expanded, isPartial: false }, theme, {} as any)!;
    const text = stripAnsi(component.render(300).join('\n'));
    assert.match(text, /Job status: cancelling/); assert.match(text, /Exit of all descendant processes is not confirmed/);
    assert.doesNotMatch(text, /\{"jobId"/);
    if (expanded) { assert.match(text, /Job ID: j/); assert.match(text, /Exit code: 130/); assert.match(text, /Retained output head/); assert.match(text, /Log: \/existing\/log/); }
    for (const width of [0, 1, 6, 24, 80]) {
      const lines = component.render(width);
      assert.ok(lines.length <= 300);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      const plain = stripAnsi(lines.join('\n'));
      if (width > 0) assert.match(plain.replace(/\s/g, ''), /Exitofalldescendantprocessesisnotconfirmed/, 'never clip the negative safety qualifier in a narrow collapsed view');
      assert.doesNotMatch(plain, /[\x00-\x08\x0b-\x1f\u202e]/);
    }
  }
  assert.equal(JSON.stringify(input), before);
});
test('background receipt uses Accepted in while synchronous results keep Took and timeout labels', () => {
  initTheme('dark', false); // Host renderer uses its read-only global palette; do not start file watchers.
  const tools = new Map<string, any>();
  registerShell({ registerTool(t: any) { tools.set(t.name, t); }, registerMessageRenderer() {}, on() {} } as any);
  const palette = { ...theme, bold: (s: string) => s };
  for (const name of ['bash', 'powershell']) {
    const tool = tools.get(name), state = { startedAt: 1000, endedAt: 1250 };
    const context: any = { state, executionStarted: true, invalidate() {} };
    assert.match(stripAnsi(tool.renderCall({ command: 'echo x', timeoutMs: 20000, background: true }, palette, context).render(300).join('\n')), /\(timeout 20s\)/);
    const receipt = { content: [{ type: 'text', text: 'Background job accepted' }], structuredContent: { jobId: 'j', status: 'running', liveLogPath: '/existing/log' } };
    const accepted = stripAnsi(tool.renderResult(receipt, { expanded: true, isPartial: false }, palette, context).render(300).join('\n'));
    assert.match(accepted, /Accepted in 0\.3s/); assert.doesNotMatch(accepted, /Took/);
    for (const flags of [{ partial: true }, { error: true }, { contextError: true }]) {
      const fallbackContext: any = { state: { startedAt: 1000, endedAt: 1250 }, invalidate() {}, isError: flags.contextError };
      try {
        const shown = stripAnsi(tool.renderResult({ ...receipt, isError: flags.error }, { expanded: true, isPartial: flags.partial === true }, palette, fallbackContext).render(300).join('\n'));
        assert.doesNotMatch(shown, /Accepted in/, 'partial/errors are not successful admission receipts');
      } finally {
        // Host partial renderer owns a timer; settle it explicitly, not via fixed waiting.
        tool.renderResult(receipt, { expanded: true, isPartial: false }, palette, fallbackContext);
        assert.equal(fallbackContext.state.interval, undefined);
      }
    }
    const synchronous = stripAnsi(tool.renderResult({ content: [{ type: 'text', text: 'done' }] }, { expanded: true, isPartial: false }, palette, { ...context, lastComponent: undefined }).render(300).join('\n'));
    assert.match(synchronous, /Took 0\.3s/); assert.doesNotMatch(synchronous, /Accepted in/);
    assert.match(tool.promptGuidelines.join(' '), /background mode keeps the same idle timeout/);
  }
  const result = { content: [{ type: 'text', text: '{"jobId":"j","status":"completed"}' }], structuredContent: { jobId: 'j', status: 'completed', exitCode: 0 } };
  const terminal = stripAnsi(tools.get('shell_job_cancel').renderResult(result, { expanded: true, isPartial: false }, palette, {}).render(300).join('\n'));
  assert.match(terminal, /Job already finished; no new cancellation was requested/);
  assert.doesNotMatch(terminal, /Cancellation requested; waiting/);
});
test('shell command previews cap physical rows at five including omission, without mutating arguments', () => {
  initTheme('dark', false);
  const tools = new Map<string, any>();
  registerShell({ registerTool(t: any) { tools.set(t.name, t); }, registerMessageRenderer() {}, on() {} } as any);
  const palette = { ...theme, bold: (s: string) => s };
  for (const name of ['bash', 'powershell']) {
    const tool = tools.get(name);
    const args = { command: Array.from({ length: 8 }, (_, i) => `echo row-${i + 1}`).join('\n'), timeoutMs: 20000, background: true };
    const before = JSON.stringify(args);
    const context: any = { state: {}, executionStarted: true, invalidate() {} };
    const component = tool.renderCall(args, palette, context);
    const lines = component.render(200);
    assert.equal(lines.length, 5);
    assert.match(stripAnsi(lines[3]), /row-4/);
    assert.match(stripAnsi(lines[4]), /\.\.\./);
    assert.match(stripAnsi(lines[4]), /timeout 20s/);
    assert.doesNotMatch(stripAnsi(lines.join('\n')), /row-5|row-8/);
    assert.equal(JSON.stringify(args), before);
    assert.equal(typeof context.state.startedAt, 'number');
    for (const width of [1, 2, 3, 6, 12, 24]) {
      const rows = component.render(width);
      assert.ok(rows.length <= 5, `width ${width}: ${rows.length} rows`);
      assert.ok(rows.every(row => visibleWidth(row) <= width));
    }
    // The host reuses its Text and timing state during streaming/re-rendering.
    const startedAt = context.state.startedAt;
    const reused = tool.renderCall({ command: 'echo short', timeout: 7 }, palette, { ...context, lastComponent: component });
    assert.equal(reused, component);
    assert.equal(context.state.startedAt, startedAt);
    assert.match(stripAnsi(reused.render(200).join('\n')), /echo short.*timeout 7s/);
    assert.doesNotMatch(stripAnsi(reused.render(200).join('\n')), /\.\.\./);
    const exact = tool.renderCall({ command: 'one\ntwo\nthree\nfour\nfive' }, palette, { ...context, lastComponent: component });
    assert.equal(exact.render(200).length, 5);
    assert.match(stripAnsi(exact.render(200).join('\n')), /five/);
    assert.doesNotMatch(stripAnsi(exact.render(200).join('\n')), /\.\.\./);
    const wrapped = tool.renderCall({ command: '界😀'.repeat(100) }, palette, { ...context, lastComponent: component });
    assert.equal(wrapped.render(12).length, 5);
    assert.match(stripAnsi(wrapped.render(12).at(-1)), /\.\.\./);
    assert.ok(wrapped.render(0).length <= 5);
    assert.doesNotThrow(() => tool.renderCall(undefined, palette, { ...context, lastComponent: component }).render(20));
    const malformed = tool.renderCall({ command: args.command, timeout: 'bad\nlabel' }, palette, { ...context, lastComponent: component });
    const malformedRows = malformed.render(200);
    assert.equal(malformedRows.length, 5);
    assert.ok(malformedRows.every(row => !row.includes('\n') && !row.includes('\r')));
    assert.equal(stripAnsi(malformedRows.at(-1)), '...');
  }
});

test('expanded output has bounded layout for huge output and narrow Unicode terminals', () => {
  show(message({ jobId: 'x', status: 'completed', exitCode: 0, command: '界😀'.repeat(5000), output: 'long 界😀\n'.repeat(30000) }), true);
});
