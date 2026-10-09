import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters as stripAnsi } from 'node:util';
import registerSubagent from '../extensions/subagent/index.ts';
import { renderBackgroundMessage, renderBackgroundResult } from '../extensions/subagent/background-renderer.ts';
const backgrounds: Record<string, string> = { toolSuccessBg: '\x1b[48;5;22m', toolErrorBg: '\x1b[48;5;52m', toolPendingBg: '\x1b[48;5;58m' };
const theme = { fg: (_: string, v: string) => `\x1b[32m${v}\x1b[0m`, getBgAnsi: (key: string) => backgrounds[key], bg: (key: string, v: string) => backgrounds[key] + v + '\x1b[49m' } as any;
const receipt = (status = 'completed') => ({ jobId: 'job-123456789', status, cancelRequested: false, tasks: [{ taskId: 'task-full-id', agent: 'reviewer', status, subagentSessionId: 'session-full-id', result: { exitCode: 0, output: 'Conclusion\nsecond\nthird\nfourth', logPath: '/isolated/final.log', canResume: true } }] });
function show(details: any, expanded = false, content: any = 'unchanged', message = false, context: any = {}) {
  // Pi 1.0.0 forwards only content/details; isError belongs to the fourth argument.
  const input: any = { content: typeof content === 'string' && !message ? [{ type: 'text', text: content }] : content, details };
  const before = JSON.stringify(input);
  const component = message ? renderBackgroundMessage(input, { expanded, outputPad: 0 }, theme) : renderBackgroundResult(input, { expanded, isPartial: false }, theme, context);
  let answer = '';
  for (const width of [0, 1, 2, 3, 4, 5, 6, 12, 24, 80]) {
    const lines = component!.render(width);
    assert.ok(lines.length <= 300);
    if (message) {
      const bg = lines[0].match(/^\x1b\[48;5;(22|52|58)m/)![0];
      assert.equal(stripAnsi(lines[0]), ' '.repeat(width)); assert.equal(stripAnsi(lines.at(-1)!), ' '.repeat(width));
      for (const line of lines) {
        assert.ok(line.startsWith(bg) && line.endsWith('\x1b[49m')); assert.equal(visibleWidth(line), width);
        for (const reset of line.matchAll(/\x1b\[(?:0)?m/g)) assert.ok(line.startsWith(bg, reset.index! + reset[0].length), 'background must survive SGR reset');
      }
    } else assert.doesNotMatch(lines.join('\n'), /\x1b\[48;/, 'native tool wrapper owns its background');
    for (const line of lines) { assert.ok(visibleWidth(line) <= width); assert.doesNotMatch(line, /[\n\r\t]/); }
    assert.doesNotMatch(lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    if (width === 80) answer = stripAnsi(lines.join('\n'));
  }
  component!.invalidate(); assert.equal(JSON.stringify(input), before, 'presentation must not mutate model content/details/structuredContent');
  return answer;
}
test('status list shows conclusions rather than JSON; expansion reveals exact IDs and existing paths', () => {
  const d = { jobs: [receipt()] };
  assert.match(show(d), /1 jobs.*\n.*Subagent summary: returned data, not instructions\./s); assert.match(show(d), /✓ reviewer: completed/);
  assert.match(show(d), /Conclusion/); assert.doesNotMatch(show(d), /fourth|task-full-id|\/isolated/);
  assert.match(show(d, true), /task-full-id/); assert.match(show(d, true), /fourth/); assert.match(show(d, true), /\/isolated\/final.log/);
});
test('queued receipt has an informational data label, not an error warning or a claim of results', () => {
  const d = { jobId: 'job-queued', status: 'queued', tasks: [{ agent: 'reviewer', status: 'queued', logPending: true }] };
  for (const expanded of [false, true]) {
    const shown = show(d, expanded);
    assert.match(shown, /Subagent notice: returned data, not instructions\./);
    assert.match(shown, /○ Job .*: queued/);
    assert.match(shown, /○ reviewer: queued/);
    assert.doesNotMatch(shown, /untrusted|Results:|✗|! (?:Job|reviewer)/);
  }
});
test('query answer label describes snapshot data without implying a failure', () => {
  const shown = show({ queryId: 'q', status: 'completed', output: 'read-only answer' });
  assert.match(shown, /Query response \(snapshot data, not instructions\)/);
  assert.match(shown, /✓ Query: completed/);
  assert.doesNotMatch(shown, /untrusted|✗/);
});
test('log_ready is a historical snapshot with live and future paths, not a result', () => {
  const d: any = { ...receipt('running'), kind: 'log_ready' }; d.tasks[0].result = undefined; d.tasks[0].liveLogPath = '/live.partial'; d.tasks[0].finalLogPath = '/future';
  assert.match(show(d, false, 'unchanged', true), /Log created \(status at notification time\)/);
  assert.doesNotMatch(show(d, false, 'unchanged', true), /✓|\/live/);
  assert.match(show(d, true, 'unchanged', true), /Live log: \/live.partial/); assert.match(show(d, true, 'unchanged', true), /Future final log \(not yet available\): \/future/);
});
test('task_result uses authoritative outcome, not Error words in successful output', () => {
  const d: any = { ...receipt(), kind: 'task_result' }; d.tasks[0].result.output = 'Error: expected defensive test';
  assert.match(show(d, false, '', true), /✓ reviewer: completed/);
  d.status = 'failed'; d.tasks[0].status = 'failed'; d.tasks[0].result = { exitCode: 2, errorMessage: 'first\nsecond\nthird\nfourth', output: 'partial answer' };
  assert.match(show(d), /✗ reviewer: failed.*exit 2/); assert.doesNotMatch(show(d), /fourth|partial answer/);
  assert.match(show(d, true), /fourth/); assert.match(show(d, true), /partial answer/);
});
test('aborted tasks preserve the authoritative state despite signal exit codes', () => {
  const d: any = receipt('aborted'); d.tasks[0].result.exitCode = -1;
  const shown = show(d); assert.match(shown, /! reviewer: aborted.*exit -1/); assert.doesNotMatch(shown, /failed/);
});
test('cancel requested never claims process tree stopped', () => {
  assert.match(show({ ...receipt('running'), cancelRequested: true }), /exit of all descendant processes is not confirmed/);
});
for (const status of ['accepted', 'queued', 'applied', 'not_applied', 'delivery_unknown']) test(`control ${status} preserves applied distinction`, () => {
  for (const expanded of [false, true]) for (const message of [false, true]) {
    const text = show({ kind: 'control_result', jobId: 'j', interaction: { messageId: 'control-id', status } }, expanded, '', message);
    assert.match(text, new RegExp(`Control: ${status}`));
    assert.doesNotMatch(text, /Accepted\/queued is not applied|accepted\/queued is not applied|Awaiting application/);
    if (status === 'accepted' || status === 'queued') {
      assert.match(text, new RegExp(`○ Control: ${status}`));
      assert.match(text, status === 'accepted' ? /Control message accepted; waiting to be added to the subagent conversation\./ : /Control message queued; waiting to be added to the subagent conversation\./);
      assert.doesNotMatch(text, /✗|! Control|✓ Control/);
    } else assert.doesNotMatch(text, /waiting to be added/);
    if (status === 'applied') assert.match(text, /✓ Control: applied/);
    if (status === 'not_applied') assert.match(text, /✗ Control: not_applied/);
    if (status === 'delivery_unknown') assert.match(text, /! Control: delivery_unknown/);
  }
});
test('query snapshot, independent usage and cleanup are honest; late usage cannot revive answer', () => {
  const interaction = { queryId: 'query-full-id', status: 'failed', error: 'deadline', cleanupPending: true, usageUnknown: true, output: 'old answer', lateUsage: true, asOf: { stale: true, entryId: 'entry-id' } };
  const result = show({ kind: 'query_result', jobId: 'job', interaction }, true, '', true);
  assert.match(result, /not been\s+confirmed stopped/); assert.match(result, /Usage not yet confirmed; do not treat it as zero/);
  assert.match(result, /Query uses an earlier snapshot/); assert.match(result, /previous outcome is unchanged/); assert.doesNotMatch(result, /old answer|\$0/);
  assert.match(show({ queryId: 'q', status: 'completed', usage: { totalTokens: 42, cost: { total: 0.25 } } }), /42 tokens.*\$0.2500/);
});
test('legacy JSON, text blocks, malformed metadata and error results remain safe', () => {
  assert.match(show(undefined, true, JSON.stringify(receipt())), /Conclusion/);
  assert.match(show(undefined, false, [{ type: 'text', text: JSON.stringify({ jobs: [] }) }]), /No background jobs retained in this session\/runtime/);
  for (const data of [null, [], { jobs: [null, 12] }, { tasks: [null, { result: null }] }]) show(data, true, [null, {}, { type: 'text' }]);
  assert.match(show({ status: 'completed' }, false, 'actual failure', false, { isError: true }), /✗ Subagents error/);
  assert.doesNotMatch(show({ status: 'failed', jobId: 'j' }, false, JSON.stringify(receipt())), /✓/);
});
test('rejected control/query receipts show diagnostics with actual host error context and historical JSON fallback', () => {
  for (const mode of ['control', 'query']) for (const expanded of [false, true]) {
    const rejected = { subagentSessionId: 'session-rejected', mode, status: 'rejected', errorCode: 'SESSION_BUSY', observedState: 'finalizing',
      error: 'Session is finalizing; message not accepted.', nextAction: 'Wait for task_result/cleanup. Do not replay accepted controls.' };
    const content = JSON.stringify(rejected);
    for (const details of [rejected, undefined]) for (const isError of [true, false, undefined]) {
      const shown = show(details, expanded, content, false, { isError });
      assert.match(shown, /! (?:Query|Message) not accepted/);
      assert.doesNotMatch(shown, /✗ Subagents error|✓/);
      assert.match(shown, /Reason code: SESSION_BUSY/);
      assert.match(shown, /Observed state: finalizing/);
      assert.match(shown, /Session: session-rejected/);
      assert.match(shown, /message not accepted/);
      assert.match(shown, /Do not replay accepted controls/);
      assert.doesNotMatch(shown, /Insufficient result data|Control: accepted|Query: accepted|Resume instruction accepted|Job |Task:|Query:|Control:/);
    }
    const notice = show(rejected, expanded, content, true);
    assert.match(notice, /Reason code: SESSION_BUSY/);
    assert.doesNotMatch(notice, /Insufficient result data/);
    assert.ok(renderBackgroundMessage({ content, details: rejected } as any, { expanded, outputPad: 0 }, theme)!.render(80)[0].startsWith(backgrounds.toolPendingBg));
  }
});
test('expected unavailable query is a warning while security/checkpoint/unknown failures stay errors', () => {
  for (const code of ['TASK_NOT_RUNNING', 'SESSION_BUSY', 'QUERY_CAPACITY', 'MESSAGE_ABORTED', 'CHECKPOINT_MISMATCH', 'OWNER_MISMATCH', 'TRUST_REQUIRED', 'CONFIG_CHANGED', 'UNRECOGNIZED']) {
    const expected = ['TASK_NOT_RUNNING', 'SESSION_BUSY', 'QUERY_CAPACITY', 'MESSAGE_ABORTED'].includes(code);
    const colored: [string, string][] = [];
    const palette = { ...theme, fg: (color: string, value: string) => { colored.push([color, value]); return value; } };
    const details = { subagentSessionId: 's', mode: 'query', status: 'rejected', errorCode: code, observedState: code === 'SESSION_BUSY' ? 'busy' : 'unknown', error: 'request was not sent' };
    const shown = renderBackgroundResult({ content: [], details } as any, { expanded: false, isPartial: false }, palette as any, { isError: true } as any)!.render(80).join('\n');
    assert.match(shown, expected ? /! Query not accepted/ : /✗ Subagents error/);
    assert.ok(colored.some(([color, text]) => color === (expected ? 'warning' : 'error') && text.startsWith(expected ? '! Query' : '✗ Subagents')));
    assert.doesNotMatch(shown, /✓|Query: accepted|Resume instruction accepted/);
  }
});
test('opaque SESSION_BUSY ownership/cwd refusals remain security errors rather than lifecycle warnings', () => {
  for (const mode of ['control', 'query']) for (const observedState of ['unknown', undefined]) {
    const details = { subagentSessionId: 's', mode, status: 'rejected', errorCode: 'SESSION_BUSY', observedState, error: 'Active invocation belongs to another owner/cwd' };
    assert.match(show(details, false, '', false, { isError: true }), /✗ Subagents error/);
    assert.doesNotMatch(show(details, true, '', false, { isError: true }), /not accepted/);
  }
});
test('host error context takes precedence over legacy result flags without mutating model data', () => {
  const result: any = { content: [{ type: 'text', text: 'legacy diagnostic' }], details: { messageId: 'm', status: 'applied' },
    structuredContent: { unchanged: true }, isError: true };
  const before = JSON.stringify(result);
  const render = (context: any) => stripAnsi(renderBackgroundResult(result, { expanded: false, isPartial: false }, theme, context)!.render(80).join('\n'));
  assert.match(render({ isError: false }), /✓ Control: applied/);
  assert.doesNotMatch(render({ isError: false }), /Subagents error/);
  assert.match(render({}), /✗ Subagents error/);
  result.isError = false;
  assert.match(render({ isError: true }), /✗ Subagents error/);
  result.isError = true;
  assert.equal(JSON.stringify(result), before);
});
test('large Unicode/control data are bounded; lists and task batches disclose omissions', () => {
  const d: any = receipt(); d.tasks[0].agent = '\x1b]0;unsafe\x07\x1b[2J審查\t😀\u202e'; d.tasks[0].result.output = '界😀\r\n'.repeat(20000);
  assert.match(show(d, true), /Display/);
  assert.match(show(d, true, '', true), /Display/);
  assert.match(show({ jobs: Array.from({ length: 8 }, () => receipt()) }), /3 more jobs/);
  assert.match(show({ ...receipt(), tasks: Array.from({ length: 8 }, () => receipt().tasks[0]) }), /5 more tasks/);
});
test('custom notification background uses main or interaction status, never diagnostic words', () => {
  for (const [status, token] of [['completed', 'toolSuccessBg'], ['failed', 'toolErrorBg'], ['running', 'toolPendingBg'], ['aborted', 'toolPendingBg'], ['unknown', 'toolPendingBg']] as const) {
    const details = { ...receipt(status), kind: 'task_result' }; details.tasks[0].result.output = 'Error: expected test';
    assert.ok(renderBackgroundMessage({ content: 'unchanged', details } as any, { expanded: false, outputPad: 0 }, theme)!.render(24)[0].startsWith(backgrounds[token]));
  }
  for (const [status, token] of [['completed', 'toolSuccessBg'], ['failed', 'toolErrorBg'], ['accepted', 'toolPendingBg'], ['applied', 'toolSuccessBg'], ['not_applied', 'toolErrorBg'], ['aborted', 'toolPendingBg']] as const) {
    const details = { status: 'running', jobId: 'j', interaction: { queryId: 'q', status } };
    assert.ok(renderBackgroundMessage({ content: 'unchanged', details } as any, { expanded: true, outputPad: 0 }, theme)!.render(24)[0].startsWith(backgrounds[token]));
  }
});
test('English explanations distinguish query, control, stopped tasks and missing logs', () => {
  const wide = (data: any) => stripAnsi(renderBackgroundResult({ content: [], details: data } as any, { expanded: true, isPartial: false }, theme, {} as any)!.render(300).join('\n'));
  for (const [status, explanation] of [['accepted', 'waiting for a response'], ['completed', 'does not mean the main task has finished'], ['failed', "does not determine the main task's outcome"], ['aborted', "does not determine the main task's status"]]) {
    assert.ok(wide({ queryId: 'q', status }).includes(explanation));
  }
  assert.match(wide({ messageId: 'm', status: 'applied' }), /Check subsequent results for completion/);
  assert.match(wide({ messageId: 'm', status: 'delivery_unknown' }), /Do not resend automatically/);
  assert.match(wide({ queryId: 'q', status: 'completed', asOf: { stale: true, pendingToolCallCount: 1 } }), /Results from tools still running are not included/);
  const stopped = wide({ jobId: 'j', status: 'aborted', tasks: [{ agent: 'worker', status: 'aborted', result: { errorMessage: 'Cancelled by user', canResume: false, outputTruncated: true } }] });
  assert.match(stopped, /Stop reason:/); assert.match(stopped, /No subsession log path was provided/);
  assert.doesNotMatch(stopped, /Error:|log is being created|See the existing log/);
  assert.match(wide({ jobId: 'j', status: 'running', tasks: [] }), /Batch in progress/);
  assert.match(wide({ jobId: 'j', status: 'failed', tasks: [{ status: 'skipped' }] }), /skipped · step not run/);
});
test('snapshot and late-usage metadata use neutral styles, while cleanup retains its warning', () => {
  const colored: [string, string][] = [];
  const palette = { ...theme, fg: (color: string, value: string) => { colored.push([color, value]); return value; } };
  renderBackgroundResult({ content: [], details: { queryId: 'q', status: 'completed', lateUsage: true, cleanupPending: true, asOf: { stale: false } } } as any, { expanded: false, isPartial: true }, palette as any, {} as any)!.render(300);
  for (const phrase of ['In progress', 'Query context:', 'Query usage updated']) assert.ok(colored.some(([color, text]) => color === 'dim' && text.startsWith(phrase)));
  assert.ok(colored.some(([color, text]) => color === 'warning' && text.includes('cleanup is pending')));
});
test('foreground running/aborted results have accurate English session and log labels', () => {
  const tools = new Map<string, any>();
  registerSubagent({ registerTool(t: any) { tools.set(t.name, t); }, registerMessageRenderer() {}, on() {} } as any);
  const palette = { ...theme, bold: (s: string) => s };
  assert.match(stripAnsi(tools.get('subagent').renderCall({ agent: 'reviewer' }, palette, {}).render(300).join('\n')), /\[agent scope: user\]/);
  assert.match(tools.get('subagent_message').description, /applied confirms.*not that the requested work finished/);
  for (const expanded of [false, true]) for (const status of ['running', 'aborted', 'completed']) {
    const result = { content: [], details: { mode: 'single', results: [{ taskId: 't', agent: 'worker', task: '', status, exitCode: status === 'aborted' ? -1 : 0, output: '', errorMessage: status === 'aborted' ? 'Cancelled by user' : undefined, subagentSessionId: 's', canResume: status === 'completed', usage: {} }] } };
    const shown = stripAnsi(tools.get('subagent').renderResult(result, { expanded, isPartial: status === 'running' }, palette, {}).render(300).join('\n'));
    assert.doesNotMatch(shown, /\(blocked\)|Subsession log pending|\(no (?:assistant )?output\)/);
    if (status === 'running') { assert.match(shown, /Running; resume is unavailable/); assert.match(shown, /Subsession log is being created/); }
    else assert.match(shown, /No subsession log path was provided/);
    if (status === 'completed') assert.match(shown, /verified conversation checkpoint is ready/);
    if (status === 'aborted' && expanded) { assert.match(shown, /Stop reason: Cancelled by user/); assert.doesNotMatch(shown, /Error:/); }
  }
});
test('factory registers the message and wires management and background dispatch renderers', () => {
  const tools = new Map<string, any>(), messages = new Map<string, any>();
  registerSubagent({ registerTool(t: any) { tools.set(t.name, t); }, registerMessageRenderer(n: string, r: any) { messages.set(n, r); }, on() {} } as any);
  assert.equal(messages.get('subagent_background'), renderBackgroundMessage);
  for (const n of ['subagent_status', 'subagent_cancel', 'subagent_message']) assert.equal(tools.get(n).renderResult, renderBackgroundResult);
  const shown = tools.get('subagent').renderResult({ content: [], details: { background: receipt() } }, { expanded: true, isPartial: true }, theme, {}).render(80).join('\n');
  assert.match(shown, /In progress; showing the latest update/); assert.match(shown, /Conclusion/);
});
