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
      if (['note', 'goal', 'web_fetch', 'web_search', 'schedule_create', 'schedule_update', 'schedule_status', 'schedule_cancel'].includes(definition.name)) {
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

  if (byName('goal')) {
    const value = { goal: { status: 'complete', objective: '測試驗收', id: 'g', runId: 'r', resultSummary: 'Delivered',
      verification: [{ criterion: 'renderer exists', evidence: 'probe passed' }], autoRequests: 0, updatedAt: '2026-10-03T07:22:58Z', cwd }, diagnostic: null };
    const result = textResult(JSON.stringify(value), value);
    assert.match(render(byName('goal'), result), /Goal: complete/);
    assert.match(render(byName('goal'), result), /model-reported, not an independent audit/);
    assert.match(render(byName('goal'), result, true), /probe passed/);
    assert.match(render(byName('goal'), textResult('{"goal":null,"diagnostic":null}', undefined)), /No goal set/);
    const blocked = { goal: { status: 'blocked', objective: 'x', stopReason: 'Permission missing', suggestedAction: 'Ask user' }, diagnostic: 'Storage problem' };
    assert.match(render(byName('goal'), textResult(JSON.stringify(blocked), blocked)), /Ask user/);
  }
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
  console.log(`[renderers] ${definitions.length} loader definitions verified: calls/results, partial/error/legacy, widths 12/24/80, output unchanged.`);
}
