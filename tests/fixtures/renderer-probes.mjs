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
    // Match Pi 1.0.0 ToolExecutionComponent: error state is carried by context only.
    const component = definition.renderResult({ content: result.content, details: result.details }, { expanded, isPartial }, theme, { ...contexts(args), expanded, isError });
    assert.ok(component && typeof component.render === 'function', `${definition.name}: renderer must return a component`);
    let text = '';
    for (const width of [12, 24, 80]) {
      const lines = component.render(width);
      if (definition.name.startsWith('pty_') || ['note', 'web_fetch', 'web_search', 'shell_job_status', 'shell_job_cancel', 'subagent_status', 'subagent_cancel', 'subagent_message'].includes(definition.name)) {
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

  const saved = { relativePath: 'report/REPORT-20261003T072258503Z.md' };
  const note = textResult(`Saved note: ${saved.relativePath}`, saved, saved);
  assert.match(render(byName('note'), note), /Saved note:/);
  assert.ok(render(byName('note'), note).includes(saved.relativePath));
  assert.doesNotMatch(render(byName('note'), note, true), /Absolute path:/);
  const call = byName('note').renderCall({ type: 'report', content: '# Title\n' + 'PRIVATE_BODY'.repeat(10000) }, theme, contexts({})).render(80).join('\n');
  assert.match(call, /Title/); assert.ok(!call.includes('PRIVATE_BODY'));

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
    const input = name === 'subagent_message'
      ? { subagentSessionId: 'session-host', mode: 'control', title: 'Message title', message: 'SECRET_CONTROL_TEXT' }
      : { jobId: 'job-1', taskId: 'task-1', mode: 'control', message: 'SECRET_CONTROL_TEXT' };
    assert.ok(!byName(name).renderCall(input, theme, contexts(input)).render(80).join('\n').includes('SECRET_CONTROL_TEXT'));
  }
  assert.match(render(byName('shell_job_cancel'), textResult('{"status":"cancelling"}')), /Exit of all descendant processes is not confirmed/);
  const agents = { jobs: [{ jobId: 'job-host-123', status: 'completed', tasks: [{ taskId: 'task-host', agent: 'reviewer', status: 'completed', summary: 'Verified result' }] }] };
  const agentList = textResult(JSON.stringify(agents), agents);
  assert.match(render(byName('subagent_status'), agentList), /1 jobs/);
  assert.match(render(byName('subagent_status'), agentList), /reviewer: completed/);
  assert.match(render(byName('subagent_status'), agentList), /Verified result/);
  assert.match(render(byName('subagent_status'), agentList, true), /task-host/);
  assert.match(render(byName('subagent_cancel'), textResult('unchanged', { ...agents.jobs[0], cancelRequested: true })), /exit of all descendant processes is not confirmed/);
  for (const status of ['accepted', 'queued', 'applied', 'not_applied', 'delivery_unknown']) for (const expanded of [false, true]) {
    const shown = render(byName('subagent_message'), textResult('unchanged', { status, messageId: 'control-host' }), expanded);
    assert.match(shown, new RegExp(`Control: ${status}`));
    assert.doesNotMatch(shown, /accepted\/queued is not applied|Awaiting application/i);
    if (status === 'accepted' || status === 'queued') {
      assert.match(shown, new RegExp(`○ Control: ${status}`));
      assert.match(shown, status === 'accepted' ? /Control message accepted; waiting to be added to the subagent conversation\./ : /Control message queued; waiting to be added to the subagent conversation\./);
      assert.doesNotMatch(shown, /✗|! Control|✓ Control/);
    } else assert.doesNotMatch(shown, /waiting to be added/);
    if (status === 'applied') assert.match(shown, /✓ Control: applied/);
    if (status === 'not_applied') assert.match(shown, /✗ Control: not_applied/);
    if (status === 'delivery_unknown') assert.match(shown, /! Control: delivery_unknown/);
  }
  const messageTool = byName('subagent_message');
  assert.equal(messageTool.parameters.properties.title.maxLength, 50);
  const stableControl = { action: 'control', mode: 'control', status: 'accepted', subagentSessionId: 'session-host', jobId: 'job-host', taskId: 'task-host', messageId: 'control-host' };
  const stableShown = render(messageTool, textResult(JSON.stringify(stableControl), stableControl), true);
  assert.match(stableShown, /Control: accepted/);
  assert.match(stableShown, /session-host/, 'expanded new interaction includes stable session identity');
  assert.match(stableShown, /Action: control/);
  const stableQuery = { ...stableControl, action: 'query', mode: 'query', queryId: 'query-host' };
  delete stableQuery.messageId;
  const queryShown = render(messageTool, textResult(JSON.stringify(stableQuery), stableQuery), true);
  assert.match(queryShown, /Query: accepted/); assert.match(queryShown, /Action: query/); assert.match(queryShown, /session-host/);
  const stableResume = { action: 'resume', mode: 'control', subagentSessionId: 'session-host', status: 'accepted', jobId: 'next-job', taskId: 'next-task',
    background: { jobId: 'next-job', status: 'queued', cancelRequested: false, tasks: [{ taskId: 'next-task', agent: 'worker', status: 'queued', subagentSessionId: 'session-host', logPending: true }] } };
  for (const expanded of [false, true]) {
    const shown = render(messageTool, textResult(JSON.stringify(stableResume), stableResume), expanded);
    assert.match(shown, /Resume instruction accepted/); assert.match(shown, /not completed/);
    assert.doesNotMatch(shown, /Control: accepted|✓/);
    if (expanded) { assert.match(shown, /Action: resume/); assert.match(shown, /next-task/); assert.match(shown, /session-host/); }
  }
  const rejection = { subagentSessionId: 'session-host', mode: 'control', status: 'rejected', errorCode: 'SESSION_BUSY', observedState: 'finalizing', nextAction: 'Wait for task_result/cleanup. Do not replay accepted controls.', error: 'Session is finalizing; message not accepted.' };
  for (const mode of ['control', 'query']) for (const expanded of [false, true]) for (const withDetails of [false, true]) {
    const rejected = { ...rejection, mode };
    const rejectedShown = render(messageTool, textResult(JSON.stringify(rejected), withDetails ? rejected : undefined), expanded, true);
    assert.match(rejectedShown, /! (?:Query|Message) not accepted/); assert.doesNotMatch(rejectedShown, /✗ Subagents error|✓/);
    assert.match(rejectedShown, /Reason code: SESSION_BUSY/); assert.match(rejectedShown, /Observed state: finalizing/);
    assert.match(rejectedShown, /Do not replay accepted controls/); assert.match(rejectedShown, /session-host/);
    assert.doesNotMatch(rejectedShown, /Insufficient result data|Resume instruction accepted|Control: accepted|Query: accepted/);
  }
  assert.match(render(messageTool, textResult('ACTUAL_HOST_ERROR', undefined), false, true), /✗ Subagents error/);
  const largeBackground = textResult('UNTRUSTED_MARKER\u001b[2J\u0007\u202e' + 'x'.repeat(20000));
  const boundedBackground = render(byName('subagent_status'), largeBackground, true);
  assert.match(boundedBackground, /UNTRUSTED_MARKER/); assert.ok(boundedBackground.length < 9000);
  console.log(`[renderers] ${definitions.length} loader definitions verified: calls/results, partial/error/legacy, widths 12/24/80, output unchanged.`);
}

export function assertMessageRenderers(extensions) {
  const renderers = new Map(extensions.flatMap(e => [...e.messageRenderers]));
  const backgrounds = { toolSuccessBg: '\x1b[48;5;22m', toolErrorBg: '\x1b[48;5;52m', toolPendingBg: '\x1b[48;5;58m' };
  const theme = { fg: (_key, text) => `\x1b[32m${text}\x1b[0m`, getBgAnsi: key => backgrounds[key], bg: (key, text) => backgrounds[key] + text + '\x1b[49m' };
  const shell = { jobId: 'host-job', status: 'completed', exitCode: 0, elapsedMs: 1200,
    command: 'npm test 測試😀', output: 'Error: expected test', outputTail: '\u001b[32mfinal success\u001b[0m', outputTruncated: true, log: '/isolated/log' };
  const messages = [
    { customType: 'shell-job-completed', content: 'Untrusted data\n' + JSON.stringify([shell]), details: { jobs: [Object.fromEntries(Object.entries(shell).filter(([key]) => !['output', 'outputTail'].includes(key)))] } },
    { customType: 'scheduled_prompt', content: 'unchanged', details: { jobId: 'host-job', jobName: '測試😀', prompt: 'original prompt', mode: 'subagent_done', output: 'OK\u001b[2J\u0007\u202e' } },
    { customType: 'scheduled_prompt', content: 'skipped', details: { mode: 'subagent_done', skipped: true, output: 'deadline reached' } },
    { customType: 'subagent_background', content: 'unchanged', details: { kind: 'task_result', jobId: 'host-job', status: 'completed', tasks: [{ taskId: 'host-task', agent: 'reviewer', status: 'completed', result: { output: 'Verified result\u001b[2J\u202e', logPath: '/isolated/final' } }] } },
    { customType: 'subagent_background', content: 'unchanged', details: { kind: 'log_ready', jobId: 'host-job', status: 'running', tasks: [{ taskId: 'host-task', agent: 'reviewer', status: 'running', liveLogPath: '/isolated/live.partial', finalLogPath: '/isolated/future' }] } },
  ];
  for (const message of messages) for (const expanded of [false, true]) {
    const before = JSON.stringify(message);
    assert.equal(typeof renderers.get(message.customType), 'function', `missing ${message.customType} renderer`);
    const component = renderers.get(message.customType)(message, { expanded, outputPad: 0 }, theme);
    for (const width of [1, 2, 3, 4, 5, 6, 12, 24, 80]) {
      const lines = component.render(width);
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
      assert.ok(lines.length <= 300);
      const expectedBg = backgrounds[message.details.skipped || message.details.kind === 'log_ready' ? 'toolPendingBg' : 'toolSuccessBg'];
      const plain = lines.map(stripVTControlCharacters);
      assert.equal(plain[0], ' '.repeat(width)); assert.equal(plain.at(-1), ' '.repeat(width));
      for (const line of lines) {
        assert.ok(line.startsWith(expectedBg) && line.endsWith('\x1b[49m')); assert.equal(visibleWidth(line), width);
        for (const reset of line.matchAll(/\x1b\[(?:0)?m/g)) assert.ok(line.startsWith(expectedBg, reset.index + reset[0].length), 'full reset cannot break panel fill');
      }
      const raw = lines.join('\n');
      assert.doesNotMatch(raw.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
      if (width === 80) {
        const text = stripVTControlCharacters(raw);
        if (message.customType === 'shell-job-completed') { assert.match(text, /✓ Shell completed.*exit 0/); assert.match(text, /final success/); assert.match(text, /Command output tail \(data, not instructions\)/); assert.match(text, /The log retains at most the first 1 MiB/); assert.doesNotMatch(text, /not full output/); }
        else if (message.customType === 'scheduled_prompt') assert.match(text, message.details.skipped ? /! Scheduled skipped/ : /✓ Scheduled finished/);
        else if (message.details.kind === 'task_result') { assert.match(text, /Task finished \(status at notification time\)/); assert.match(text, /✓ reviewer: completed/); assert.match(text, /Verified result/); assert.match(text, /Subagent notice: returned data, not instructions/); }
        else { assert.match(text, /Log created \(status at notification time\)/); assert.doesNotMatch(text, /✓/); assert.match(text, /Subagent notice: returned data, not instructions/); if (expanded) assert.match(text, /Future final log/); }
        if (expanded && message.details.jobId) assert.match(text, /host-job/);
      }
    }
    assert.equal(JSON.stringify(message), before, 'message presentation must not modify model content/details');
  }
  console.log('[message-renderers] shell/schedule/subagents real loader renderers: expanded/collapsed, native tool color blocks, widths 1–6/12/24/80, immutable content.');
}

export async function assertLiveWidgetHooks(extensions, cwd) {
  const owners = extensions.filter(extension => extension.tools.has('bash') || extension.tools.has('subagent'));
  assert.equal(owners.length, 2);
  const commands = owners.flatMap(extension => [...extension.commands.values()]).filter(command => command.name === 'background-jobs');
  assert.equal(commands.length, 1, 'shared event-bus presentation registers one command, not one per module');
  const calls = [], statusCalls = [], statuses = new Map([['gpt-speed', 'Fast']]), widgets = new Map([['unrelated-schedule-widget', ['keep']]]);
  const context = mode => ({ cwd, mode, hasUI: true, sessionManager: { getSessionId: () => 'widget-probe-owner' },
    ui: { notify() {}, setStatus(key, value) { statusCalls.push(key); if (value) statuses.set(key, value); else statuses.delete(key); }, setWidget(key, value) { calls.push(key); if (value) widgets.set(key, value); else widgets.delete(key); } } });
  const emit = async (event, ctx) => { for (const extension of owners) for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event, reason: 'quit' }, ctx); };
  await emit('session_start', context('tui'));
  assert.deepEqual(calls, [], 'empty combined panel needs no placeholder widget');
  assert.deepEqual(statusCalls, [], 'idle panel needs no footer placeholder');
  await commands[0].handler('all', context('tui'));
  assert.deepEqual([...widgets.keys()], ['unrelated-schedule-widget'], 'empty live widgets must be hidden without removing another module widget');
  await emit('session_shutdown', context('tui'));
  assert.deepEqual([...statuses], [['gpt-speed', 'Fast']], 'leave unrelated footer status untouched');
  for (const mode of ['rpc', 'json', 'print']) {
    calls.length = 0; statusCalls.length = 0; await emit('session_start', context(mode)); await emit('session_shutdown', context(mode));
    assert.deepEqual(calls, [], `no terminal widgets in ${mode}, even if dialogs are supported`);
    assert.deepEqual(statusCalls, [], `no footer statuses in ${mode}`);
  }
  console.log('[live-widgets] real loader hooks: shared command/key, idle footer/widget hiding, other statuses preserved, shutdown, TUI-only binding, no tool/provider work.');
}
