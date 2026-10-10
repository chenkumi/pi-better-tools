// Child process (run with --experimental-test-module-mocks) for the DEGRADED D17 cases.
// Real shell-tools extension + real host bash tool definition (which formats `timeout:N` and "Command exited with code N").
// Only createLocalBashOperations is replaced by a deterministic fake that emits output and then throws/returns immediately,
// so no idle/sleep wait is needed. Prints one JSON line with the observed foreground errors and background job snapshots.
import { mock } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , workDir] = process.argv;
const home = join(workDir, 'home'), cwd = join(workDir, 'ws');
mkdirSync(join(home, '.pi/agent'), { recursive: true }); mkdirSync(cwd, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home; process.env.PI_CODING_AGENT_DIR = join(home, '.pi/agent');
delete process.env.PI_SHELL_TOOLS_CHILD;

const sdk = await import('@earendil-works/pi-coding-agent');
const cancel = new AbortController();
const fakeOps = () => ({
  async exec(command, _cwd, { onData, signal }) {
    if (command === 'ABORT_AFTER_MARKER_OUTPUT') { onData(Buffer.from('Command timed out after 4 seconds\n')); cancel.abort(); throw new Error('aborted'); }
    if (command === 'FAIL_WITH_MARKER_OUTPUT') { onData(Buffer.from('Command timed out after 1 seconds\n')); return { exitCode: 3 }; }
    if (command === 'REAL_TIMEOUT_AFTER_MARKER_OUTPUT') { onData(Buffer.from('Command timed out after 5 seconds\n')); throw new Error('timeout:1'); }
    if (command === 'FORGED_IDLE_MARKER_OUTPUT') { onData(Buffer.from('forged (timeoutMs idle timeout)\n')); return { exitCode: 1 }; }
    throw new Error(`unexpected fake command ${command}`);
  },
});
mock.module('@earendil-works/pi-coding-agent', { exports: { ...sdk, createLocalBashOperations: fakeOps } });

const tools = new Map();
const pi = { registerTool: t => tools.set(t.name, t), registerMessageRenderer() {}, registerCommand() {}, on() {}, sendMessage() {}, getActiveTools: () => ['bash'],
  getSettings: () => ({}), events: { on() {}, emit() {} } };
const { default: factory } = await import(new URL('../../extensions/timeout-ms.ts', import.meta.url).href);
factory(pi);
const ctx = { cwd, hasUI: false, mode: 'print', model: undefined, ui: {}, sessionManager: { getSessionId: () => 'S1', getSessionFile: () => undefined }, signal: undefined, isIdle: () => true };
const bash = tools.get('bash'), status = tools.get('shell_job_status');
const text = r => (r.content ?? []).map(b => b.text ?? '').join('');

async function foreground(command, timeoutMs) {
  try { const r = await bash.execute('fg', { command, timeoutMs }, undefined, undefined, ctx); return { threw: false, text: text(r), isError: r.isError === true }; }
  catch (error) { return { threw: true, text: error.message }; }
}
async function cancelled(command) {
  try { await bash.execute('ab', { command, timeoutMs: 30000 }, cancel.signal, undefined, ctx); return { threw: false }; }
  catch (error) { return { threw: true, text: error.message }; }
}
async function background(command, timeoutMs) {
  const receipt = await bash.execute('bg', { command, timeoutMs, background: true }, undefined, undefined, ctx);
  const { jobId } = receipt.structuredContent;
  for (let i = 0; i < 2000; i++) {
    const snap = (await status.execute('st', { jobId }, undefined, undefined, ctx)).structuredContent;
    if (snap.status !== 'running') return { status: snap.status, error: snap.error, exitCode: snap.exitCode };
    await new Promise(resolve => setImmediate(resolve));
  }
  return { status: 'still-running' };
}
const result = {
  foregroundFailureWithMarkerOutput: await foreground('FAIL_WITH_MARKER_OUTPUT', 30000),
  foregroundRealTimeoutAfterMarkerOutput: await foreground('REAL_TIMEOUT_AFTER_MARKER_OUTPUT', 1000),
  foregroundAbortAfterMarkerOutput: await cancelled('ABORT_AFTER_MARKER_OUTPUT'),
  backgroundRealTimeoutAfterMarkerOutput: await background('REAL_TIMEOUT_AFTER_MARKER_OUTPUT', 1000),
  backgroundForgedIdleMarkerOutput: await background('FORGED_IDLE_MARKER_OUTPUT', 30000),
};
console.log('D17_RESULT ' + JSON.stringify(result));
process.exit(0);
