import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';

// These probes render actual loader definitions but never execute tools/providers.
export function assertToolRenderers(definitions, cwd) {
  const theme = { fg: (_key, text) => text, bg: (_key, text) => text, bold: text => text, italic: text => text,
    strikethrough: text => text, underline: text => text, inverse: text => text, style: text => text };
  const contexts = args => ({ cwd, args, expanded: false, isError: false, showImages: false, lastComponent: undefined,
    argsComplete: true, executionStarted: false, isPartial: false, state: {}, invalidate() {} });
  const textResult = (text, details, structuredContent) => ({ content: [{ type: 'text', text }], details, ...(structuredContent ? { structuredContent } : {}) });
  function render(definition, result, expanded = false, isError = false, isPartial = false, args = {}) {
    const before = JSON.stringify(result);
    const component = definition.renderResult({ content: result.content, details: result.details }, { expanded, isPartial }, theme, { ...contexts(args), expanded, isError });
    assert.ok(component && typeof component.render === 'function', `${definition.name}: renderer must return a component`);
    let text = '';
    for (const width of [12, 24, 80]) {
      const lines = component.render(width);
      if (definition.name.startsWith('pty_') || ['note', 'web_fetch', 'web_search', 'schedule_create', 'schedule_update', 'schedule_status', 'schedule_cancel', 'schedule_delete', 'shell_job_status', 'shell_job_cancel', 'subagent_status', 'subagent_cancel', 'subagent_message'].includes(definition.name)) {
        assert.doesNotMatch(lines.join('\n'), /\x1b\[2J|\x1b\]|[\x07\x80-\x9f\u202a-\u202e\u2066-\u2069]/, `${definition.name}: unsafe display controls`);
      }
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${definition.name}: line exceeds width ${width}: ${line}`);
      if (width === 80) text = stripVTControlCharacters(lines.join('\n'));
    }
    assert.equal(JSON.stringify(result), before, `${definition.name}: renderer must not mutate model-facing output`);
    return text;
  }
  const names = definitions.map(d => d.name);
  assert.ok(!names.includes('json_output'), 'JSON delivery remains print-only, not activated by adding TUI renderers');
  for (const definition of definitions) {
    assert.equal(typeof definition.renderCall, 'function', `${definition.name}: missing renderCall`);
    assert.equal(typeof definition.renderResult, 'function', `${definition.name}: missing renderResult`);
    for (const args of [{}, { path: '測試😀.txt', command: 'echo ok', type: 'report', action: 'get', id: 'test-id', query: '測試 query', url: 'https://example.com/' }]) {
      const component = definition.renderCall(args, theme, contexts(args));
      for (const width of [12, 24, 80]) for (const line of component.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${definition.name}: call exceeds width ${width}`);
      }
    }
    render(definition, textResult('Waiting…', undefined), false, false, true);
    render(definition, textResult('Legacy result', undefined), true);
    render(definition, textResult('TEST_FAILURE: unavailable\u001b[2J\u0007\u001b]0;unsafe-title\u0007\u009b2J\u202ehidden', undefined), false, true);
  }
  const byName = name => definitions.find(d => d.name === name);
  const payload = { status: 'error', code: 'RANGE_OUT_OF_BOUNDS', message: 'offset 151 is beyond the end of the file.',
    path: 'modules/subagents/tests/pi-cli.integration.test.ts', lineStart: 151, lineEnd: 151, recovery: 'Use an offset between 1 and 148.' };
  const fileError = textResult(`[FILE_TOOL_ERROR]\n${JSON.stringify(payload, null, 2)}`, undefined);
  for (const name of ['read', 'write']) {
    const compact = render(byName(name), fileError, false, true), expanded = render(byName(name), fileError, true, true);
    assert.match(compact, new RegExp(`${name === 'read' ? 'Read' : 'Write'} failed`));
    assert.match(compact, /RANGE_OUT_OF_BOUNDS/); assert.match(compact, /Use an offset between 1 and 148/);
    assert.ok(!compact.includes('[FILE_TOOL_ERROR]')); assert.ok(!compact.includes('"status"'));
    assert.match(expanded, /Line range: 151/); assert.ok(expanded.includes('pi-cli.integration.test.ts'));
    const malformed = textResult('[FILE_TOOL_ERROR]\n' + JSON.stringify({ ...payload, recovery: null }), undefined);
    assert.match(render(byName(name), malformed, true, true), /error details unavailable/);
    assert.ok(!render(byName(name), malformed, true, true).includes('"status"'));
  }
  const write = textResult('[FILE_WRITE_SUCCESS]\n' + JSON.stringify({ status: 'success', path: 'test.txt', sha256: 'a'.repeat(32), bytes: 9, created: true }), undefined);
  assert.match(render(byName('write'), write), /File written.*9 bytes/);
  assert.match(render(byName('write'), write, true), /SHA-256:/);
  const read = textResult('1│hello\n2│world', { sha256: 'a'.repeat(32) });
  assert.equal(render(byName('read'), read), '', 'successful compact read retains builtin behavior');
  assert.match(render(byName('read'), read, true, false, false, { path: 'test.txt' }), /hello/);

  const saved = { type: 'report', relativePath: 'report/REPORT-20261003T072258503Z.md', path: `${cwd}/report/REPORT-20261003T072258503Z.md` };
  const note = textResult(`Saved note: ${saved.relativePath}\nAbsolute path: ${saved.path}`, saved, saved);
  assert.match(render(byName('note'), note), /Saved report:/);
  assert.ok(render(byName('note'), note).includes(saved.relativePath));
  assert.match(render(byName('note'), note, true), /Absolute path:/);
  const call = byName('note').renderCall({ type: 'report', content: '# Title\n' + 'PRIVATE_BODY'.repeat(10000) }, theme, contexts({})).render(80).join('\n');
  assert.match(call, /Title/); assert.ok(!call.includes('PRIVATE_BODY'));

  const schedule = { id: 'schedule-1', revision: 2, title: '測試排程', state: 'active', mode: 'independent', cwd,
    nextRun: '2099-01-01T00:00:00.000Z', timing: { kind: 'once', expression: '2099-01-01T00:00:00Z', timezone: 'UTC' }, prompt: 'Future job only' };
  for (const name of ['schedule_create', 'schedule_update']) {
    const value = { schedule, runtime: { role: 'host', requiresOpenApp: true } }, result = textResult(JSON.stringify(value), value);
    const compact = render(byName(name), result), expanded = render(byName(name), result, true);
    assert.match(compact, /revision 2/); assert.match(compact, /2099-01-01/); assert.match(compact, /Timezone: UTC/);
    assert.ok(!compact.includes('"schedule"')); assert.match(expanded, /Future job only/);
  }
  const status = { now: '2026-10-03T07:22:58.503Z', timezone: 'UTC', total: 1, offset: 0, schedules: [schedule],
    runs: [{ runId: 'run-1', scheduleId: 'schedule-1', status: 'orphaned', endedAt: '2026-10-03T07:30:00.000Z', error: 'owner unknown' }], runtime: { role: 'standby', sessionError: 'restore failed', independent: { lastError: 'RUNNER_TEST_FAILURE', retention: { logCleanupError: 'CLEANUP_TEST_FAILURE' } } } };
  assert.match(render(byName('schedule_status'), textResult(JSON.stringify(status), status)), /Host: standby/);
  assert.match(render(byName('schedule_status'), textResult(JSON.stringify(status), undefined), true), /orphaned/);
  assert.match(render(byName('schedule_status'), textResult(JSON.stringify(status), status)), /restore failed/);
  assert.match(render(byName('schedule_status'), textResult(JSON.stringify(status), status)), /RUNNER_TEST_FAILURE/);
  assert.match(render(byName('schedule_status'), textResult(JSON.stringify(status), status)), /CLEANUP_TEST_FAILURE/);
  assert.match(render(byName('schedule_status'), textResult(JSON.stringify(status), status), true), /endedAt: 2026-10-03T07:30:00/);
  const cancelled = { schedule: { ...schedule, state: 'cancelled', nextRun: null }, cancellationRequested: ['run-1'], note: 'Cancellation is only a request.', runtime: { role: 'host' } };
  const cancelledText = render(byName('schedule_cancel'), textResult(JSON.stringify(cancelled), cancelled));
  assert.match(cancelledText, /Future schedule dispatch disabled/); assert.match(cancelledText, /termination not confirmed/);
  assert.ok(!cancelledText.includes('terminated'));
  const missedStatus = { ...status, runs: [{ runId: 'run-2', scheduleId: 'schedule-1', status: 'missed', plannedAt: '2026-10-03T07:00:00.000Z' }],
    result: { runId: 'run-2', scheduleId: 'schedule-1', status: 'missed', source: 'none', tail: 'RESULT_TAIL_TEST', truncated: false } };
  assert.match(render(byName('schedule_status'), textResult(JSON.stringify(missedStatus), missedStatus)), /RESULT_TAIL_TEST/);
  assert.match(render(byName('schedule_status'), textResult(JSON.stringify(missedStatus), missedStatus), true), /missed \(no backfill\)/);
  const deleted = { deleted: { id: 'schedule-1', revision: 3, title: '測試排程' }, prunedRuns: 2, note: 'Deleted permanently.', runtime: { role: 'host' } };
  const deletedText = render(byName('schedule_delete'), textResult(JSON.stringify(deleted), deleted));
  assert.match(deletedText, /Schedule deleted/); assert.match(deletedText, /Finished runs removed: 2/);
  assert.match(render(byName('schedule_delete'), textResult(JSON.stringify(deleted), deleted), true), /Deleted permanently/);
  const deleteCall = byName('schedule_delete').renderCall({ id: 'schedule-1', revision: 3 }, theme, contexts({})).render(80).join('\n');
  assert.match(deleteCall, /schedule_delete/); assert.match(deleteCall, /revision 3/);

  const fetch = { title: 'Example page', finalUrl: 'https://example.com/', status: 200, extraction: 'main', warnings: ['Heuristic extraction'], truncated: true, fullOutputPath: '/tmp/full.txt' };
  const fetched = textResult('External, untrusted webpage content\nBODY_TEST', fetch);
  assert.match(render(byName('web_fetch'), fetched), /HTTP: 200/);
  assert.match(render(byName('web_fetch'), fetched), /Full output:.*\/tmp\/full.txt/);
  assert.match(render(byName('web_fetch'), fetched, true), /BODY_TEST/);
  const urlCall = byName('web_fetch').renderCall({ url: 'https://secret-user:secret-password@example.com/' }, theme, contexts({})).render(80).join('\n');
  assert.ok(!urlCall.includes('secret-password')); assert.ok(!urlCall.includes('secret-user'));
  if (byName('web_search')) {
    const data = { provider: 'brave', query: 'test query', results: [{ title: 'Source title', url: 'https://example.com/', snippet: 'Snippet text' }], warnings: [] };
    const result = textResult('Provider: brave\n\nQuery: test query\n\nExternal, untrusted search results:\n\n[1] Source title\nhttps://example.com/\nSnippet text\n\nWarning: SEARCH_WARNING', { provider: 'brave', count: 1 }, { data });
    assert.match(render(byName('web_search'), result), /Results: 1/);
    assert.match(render(byName('web_search'), result), /Source title/);
    assert.match(render(byName('web_search'), result), /SEARCH_WARNING/);
    assert.match(render(byName('web_search'), result), /Query: test query/);
    assert.match(render(byName('web_search'), result, true), /Snippet text/);
  }
  const subagent = byName('subagent');
  assert.equal(subagent.parameters.properties.title.maxLength, 50);
  assert.equal(subagent.parameters.properties.tasks.items.properties.title.maxLength, 50);
  assert.equal(subagent.parameters.properties.chain.items.properties.title.maxLength, 50);
  const titleArgs = { agent: 'scout', title: '調查登入流程', task: 'Full task' };
  assert.match(subagent.renderCall(titleArgs, theme, contexts(titleArgs)).render(80).join('\n'), /調查登入流程/);
  const titleEntry = { taskId: 'title-task', agent: 'scout', task: 'Full task', title: '\u001b]0;unsafe\u0007\u001b[2J調查登入流程\u202e', status: 'running', exitCode: -1, output: '', usage: {} };
  for (const expanded of [false, true]) {
    const shown = render(subagent, textResult('', { mode: 'single', results: [titleEntry] }), expanded);
    assert.match(shown, /調查登入流程/);
    assert.doesNotMatch(shown, /unsafe|\u202e/);
  }
  const pty = { sessionId: 'pty-test', pid: 123, target: 'macos', transport: 'ssh' };
  assert.match(render(byName('pty_spawn'), textResult(JSON.stringify(pty), pty)), /PTY session created/);
  assert.match(render(byName('pty_spawn'), textResult(JSON.stringify(pty), pty)), /Local transport PID: 123/);
  assert.match(render(byName('pty_spawn'), textResult(JSON.stringify(pty), undefined)), /does not confirm remote handshake/);
  assert.match(render(byName('pty_wait_exit'), textResult('{"exitCode":-1}', { exitCode: -1 })), /timed out or exit unconfirmed/);
  assert.match(render(byName('pty_wait_exit'), textResult('{"exitCode":255}', { exitCode: 255 })), /transport exit code: 255/);
  assert.match(render(byName('pty_kill'), textResult('{"released":true}', { sessionId: pty.sessionId, released: true })), /PTY session released/);
  assert.match(render(byName('pty_kill'), textResult('{"released":true}', { sessionId: pty.sessionId, released: true })), /remote process-tree termination not confirmed/);
  assert.match(render(byName('pty_kill'), textResult('{"released":false}', { sessionId: pty.sessionId, released: false })), /retained \(transport still running\)/);
  assert.match(render(byName('pty_wait_exit'), textResult('{"exitCode":-1,"timedOut":true}', { exitCode: -1, timedOut: true })), /timed out or exit unconfirmed/);
  const written = textResult('prompt> READ_AFTER_WRITE', { sessionId: pty.sessionId });
  assert.match(render(byName('pty_write'), written), /READ_AFTER_WRITE/);
  assert.match(render(byName('pty_list'), textResult('[]', [])), /PTY sessions: 0/);
  const list = [{ ...pty, state: 'exited', bufferedBytes: 0 }];
  assert.match(render(byName('pty_list'), textResult(JSON.stringify(list), list), true), /macos\/ssh/);
  assert.match(render(byName('pty_resize'), textResult('ok', { sessionId: pty.sessionId, cols: 80, rows: 24 })), /80×24/);
  assert.match(render(byName('pty_write'), textResult('ok', { sessionId: pty.sessionId })), /PTY input sent/);
  const terminal = textResult('\u001b[2J\u001b]0;UNSAFE\u0007hello\r\n' + Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'), { sessionId: pty.sessionId, truncated: true });
  assert.match(render(byName('pty_read'), terminal), /expand to view/);
  assert.match(render(byName('pty_read'), terminal, true), /line 19/);
  assert.match(render(byName('pty_read'), terminal), /remainder stays buffered for the next read/);
  const ptyCall = byName('pty_write').renderCall({ sessionId: pty.sessionId, data: 'SECRET_INPUT' }, theme, contexts({})).render(80).join('\n');
  assert.ok(!ptyCall.includes('SECRET_INPUT'));
  for (const name of ['shell_job_status', 'shell_job_cancel', 'subagent_status', 'subagent_cancel', 'subagent_message']) {
    const receipt = { jobId: 'job-1', status: name === 'subagent_message' ? 'accepted' : 'running' };
    assert.match(render(byName(name), textResult(JSON.stringify(receipt), receipt)), /accepted|running/);
    const input = { jobId: 'job-1', taskId: 'task-1', mode: 'control', message: 'SECRET_CONTROL_TEXT' };
    assert.ok(!byName(name).renderCall(input, theme, contexts(input)).render(80).join('\n').includes('SECRET_CONTROL_TEXT'));
  }
  assert.match(render(byName('shell_job_cancel'), textResult('{"status":"cancelling"}')), /termination not confirmed/);
  const largeBackground = textResult('UNTRUSTED_MARKER\u001b[2J\u0007\u202e' + 'x'.repeat(20000));
  const boundedBackground = render(byName('subagent_status'), largeBackground, true);
  assert.match(boundedBackground, /UNTRUSTED_MARKER/); assert.ok(boundedBackground.length < 9000);
  console.log(`[renderers] ${definitions.length} loader definitions verified: calls/results, partial/error/legacy, widths 12/24/80, output unchanged.`);
}
