// Child process (run with --experimental-test-module-mocks) for the foreground auto-background safety net.
// Real shell-tools extension + real host bash definition; only createLocalBashOperations is replaced by a controllable
// fake process so the handoff is driven by explicit events (output, finish, abort) rather than real long commands.
// autoBackgroundMs is set to a few milliseconds through the settings seam; no assertion waits for it to elapse.
import { mock } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , workDir] = process.argv;
const home = join(workDir, 'home'), cwd = join(workDir, 'ws');
mkdirSync(join(home, '.pi/agent'), { recursive: true }); mkdirSync(cwd, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home; process.env.PI_CODING_AGENT_DIR = join(home, '.pi/agent');
delete process.env.PI_SHELL_TOOLS_CHILD;

const sdk = await import('@earendil-works/pi-coding-agent');
const control = { emit: undefined, finish: undefined, aborted: false, processes: 0 };
const fakeOps = () => ({
  async exec(command, _cwd, { onData, signal }) {
    control.processes++;
    if (command === 'FAST') { onData(Buffer.from('fast\n')); return { exitCode: 0 }; }
    if (command === 'SLOW') {
      onData(Buffer.from('early\n'));
      control.emit = onData; control.aborted = false;
      return await new Promise((resolve, reject) => {
        control.finish = code => resolve({ exitCode: code });
        signal.addEventListener('abort', () => { control.aborted = true; reject(new Error('aborted')); }, { once: true });
      });
    }
    throw new Error(`unexpected fake command ${command}`);
  },
});
mock.module('@earendil-works/pi-coding-agent', { exports: { ...sdk, createLocalBashOperations: fakeOps } });

const tools = new Map();
let autoMs = 20, shortcut;
const pi = { registerTool: t => tools.set(t.name, t), registerShortcut: (key, options) => { shortcut = { key, ...options }; }, registerMessageRenderer() {}, registerCommand() {}, on() {}, sendMessage() {}, getActiveTools: () => ['bash', 'shell_job_status', 'shell_job_cancel'],
  getSettings: () => ({ 'pi-shell-tools': { autoBackgroundMs: autoMs } }), events: { on() {}, emit() {} } };
const { default: factory } = await import(new URL('../../extensions/timeout-ms.ts', import.meta.url).href);
factory(pi);
const ctx = { cwd, hasUI: false, mode: 'print', model: undefined, ui: {}, sessionManager: { getSessionId: () => 'S1', getSessionFile: () => undefined }, signal: undefined, isIdle: () => true };
const bash = tools.get('bash'), status = tools.get('shell_job_status'), cancel = tools.get('shell_job_cancel');
const text = r => (r.content ?? []).map(b => b.text ?? '').join('');
const settle = async jobId => {
  for (let i = 0; i < 5000; i++) {
    const snap = (await status.execute('st', { jobId }, undefined, undefined, ctx)).structuredContent;
    if (snap.status !== 'running' && snap.status !== 'cancelling') return snap;
    await new Promise(resolve => setImmediate(resolve));
  }
  return { status: 'still-running' };
};
const call = async (command, signal, useCtx = ctx) => {
  try { const r = await bash.execute(`call-${control.processes}`, { command }, signal, undefined, useCtx); return { threw: false, text: text(r), receipt: r.structuredContent?.jobId ? r.structuredContent : undefined, isError: r.isError === true }; }
  catch (error) { return { threw: true, text: error.message }; }
};

const result = {};
result.fast = await call('FAST');

const slow = await call('SLOW');
control.emit(Buffer.from('late\n')); control.finish(0);
result.slowReceipt = { text: slow.text, hasReceipt: slow.receipt?.status === 'running' };
const slowFinal = await settle(slow.receipt.jobId);
result.slowFinal = { status: slowFinal.status, exitCode: slowFinal.exitCode, output: slowFinal.output };

const turn = new AbortController();
const kept = await call('SLOW', turn.signal);
turn.abort();
const abortedAfterHandoff = control.aborted;
control.finish(0);
const keptFinal = await settle(kept.receipt.jobId);
result.turnAbortAfterHandoff = { processAborted: abortedAfterHandoff, status: keptFinal.status };

const cancelled = await call('SLOW');
await cancel.execute('cx', { jobId: cancelled.receipt.jobId }, undefined, undefined, ctx);
const cancelledFinal = await settle(cancelled.receipt.jobId);
result.jobCancel = { processAborted: control.aborted, status: cancelledFinal.status };

const baselineJobs = (await status.execute('ls0', {}, undefined, undefined, ctx)).structuredContent.jobs.length;
const early = new AbortController();
const pending = call('SLOW', early.signal);
early.abort();
const earlyResult = await pending;
result.abortBeforeHandoff = { threw: earlyResult.threw, text: earlyResult.text, aborted: control.aborted, newJobs: (await status.execute('ls', {}, undefined, undefined, ctx)).structuredContent.jobs.length - baselineJobs };

// Manual detach shortcut: autoBackgroundMs is disabled so only the shortcut can trigger the handoff.
autoMs = 0;
const ui = { statuses: [], notices: [], setStatus: (key, value) => ui.statuses.push(value), notify: message => ui.notices.push(message) };
const uiCtx = { ...ctx, hasUI: true, ui };
shortcut.handler(uiCtx);
const idleNotice = ui.notices.pop();
const processesBeforeSlow = control.processes;
const slowCallId = `call-${processesBeforeSlow}`;
const manualPending = call('SLOW', undefined, uiCtx);
while (control.processes <= processesBeforeSlow) await new Promise(resolve => setImmediate(resolve));
// The fake process is the event that the run started; nothing waits on a timer or on a status write.
const stubTheme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text };
// The host's own bash renderer reads Pi's global theme; the fixture renders it headlessly, so initialise it first.
sdk.initTheme();
const renderContext = toolCallId => ({ args: { command: 'SLOW' }, toolCallId, invalidate() {}, lastComponent: undefined, state: {}, cwd, executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false, durationMs: undefined, outputPad: 0 });
const renderCall = () => bash.renderCall({ command: 'SLOW' }, stubTheme, renderContext(slowCallId)).render(80).join('\n');
const renderPartialResult = () => bash.renderResult({ content: [{ type: 'text', text: 'early\n' }], details: undefined }, { expanded: false, isPartial: true }, stubTheme, renderContext(slowCallId)).render(80).join('\n');
const statusWhileRunning = ui.statuses[0];
const runningCallText = renderCall();
const runningResultText = renderPartialResult();
shortcut.handler(uiCtx);
const manual = await manualPending;
const hintAfterDetach = renderCall();
const resultHintAfterDetach = renderPartialResult();
control.emit(Buffer.from('after\n')); control.finish(0);
const manualFinal = await settle(manual.receipt.jobId);
result.manualDetach = { key: shortcut.key, idleNotice, statusWhileRunning, statusAfter: ui.statuses.at(-1), runningCallText, runningResultText, hintAfterDetach, resultHintAfterDetach, notice: ui.notices.at(-1), text: manual.text, hasReceipt: manual.receipt?.status === 'running', status: manualFinal.status, output: manualFinal.output };

console.log('AUTO_BG_RESULT ' + JSON.stringify(result));
process.exit(0);
