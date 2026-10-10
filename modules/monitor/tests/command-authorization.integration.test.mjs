// R03 (DESIGN DECISION, not a confirmed vulnerability): a tool_call policy that denies `bash`
// does not cover monitor_start { source: { kind: 'command', tool: 'bash', command } }, because Monitor
// spawns its own backend (modules/shell-tools/src/monitor-exec.ts) and never goes through nested bash hooks.
// Run: node --import tsx --test modules/monitor/tests/command-authorization.integration.test.mjs
// Fidelity: real Pi 1.1.0 host + real shell-tools + real monitor extension; a fake offline provider scripts the tool calls.
// RED  => a bash-denying policy did NOT stop the monitor command (marker file written).
// Case 3 shows a policy CAN intercept monitor_start via input.source.command (so a fix is policy-side or ctx.executeTool).
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, after } from 'node:test';
import { makeSandbox, startHost, waitFor } from '../../../tests/helpers/regression/host-r.mjs';

const sandbox = await makeSandbox('r03');
after(() => sandbox.cleanup());
const exists = (p) => access(p).then(() => true, () => false);
const model = { id: 'offline', name: 'Offline', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function scenario(name, toolCall, policy) {
  const seen = [];
  const host = await startHost({
    sandbox, extensionPaths: ['modules/shell-tools/src/index.ts', 'modules/monitor/src/index.ts'],
    tools: ['bash', 'monitor_start', 'monitor_status'], select: ['r03-offline', 'offline'],
    factories: [(pi) => pi.on('tool_call', (event) => { seen.push({ tool: event.toolName, input: event.input }); return policy(event); })],
    providers: [{ name: 'r03-offline', api: 'openai-responses', models: [model],
      script: (nth) => nth === 1 ? [{ type: 'toolCall', id: `call-${name}`, name: toolCall.name, arguments: toolCall.args }] : undefined }],
  });
  try {
    console.error(`[R03] ${name}: prompting; active tools=${host.session.getActiveToolNames().join(',')}`);
    await host.session.prompt('run the scripted tool call');
    const result = host.session.messages.filter((m) => m.role === 'toolResult').map((m) => ({ isError: m.isError, text: JSON.stringify(m.content).slice(0, 300) }));
    return { host, seen, result };
  } catch (e) { await host.close(); throw e; }
}
const denyBash = (event) => event.toolName === 'bash' ? { block: true, reason: 'POLICY: bash is denied' } : undefined;
const denyBashAndMonitorCommand = (event) => (event.toolName === 'bash' || (event.toolName === 'monitor_start' && event.input?.source?.kind === 'command'))
  ? { block: true, reason: 'POLICY: command execution denied (incl. monitor_start source.command)' } : undefined;
const monitorCall = (file) => ({ name: 'monitor_start', args: { source: { kind: 'command', tool: 'bash', command: `printf MONITOR_RAN > ${file}` }, durationMs: 5000, wakeAgent: false } });

test('R03 control: policy denying bash blocks a direct bash call', { timeout: 90000 }, async () => {
  const file = 'marker-bash.txt';
  const { host, result } = await scenario('control-bash', { name: 'bash', args: { command: `printf BASH_RAN > ${file}` } }, denyBash);
  try {
    console.error(`[R03] control result=${JSON.stringify(result)}`);
    assert.equal(await exists(join(sandbox.cwd, file)), false, 'bash command must not run under the deny policy');
  } finally { await host.close(); }
});

// todo = documented design decision, not a CI failure: today monitor_start is its own tool and a policy must name it (see README "命令授權範圍").
// Changing that (nested bash hooks / ctx.executeTool) is a product authorization decision; this test records the desired behaviour if it is made.
test('R03 (design decision) bash-deny policy must also prevent monitor_start source.command from executing', { timeout: 90000, todo: 'design decision: monitor_start command authorization is its own tool scope (see monitor README)' }, async () => {
  const file = 'marker-monitor-denybash.txt';
  const { host, seen, result } = await scenario('monitor-denybash', monitorCall(file), denyBash);
  try {
    const ran = await waitFor(() => exists(join(sandbox.cwd, file)), 15000);
    console.error(`[R03] tool_call events seen by policy=${JSON.stringify(seen.map((s) => s.tool))} toolResult=${JSON.stringify(result)} markerWritten=${ran}`);
    if (ran) console.error(`[R03] marker content=${await readFile(join(sandbox.cwd, file), 'utf8')}`);
    assert.equal(ran, false, 'monitor_start ran a bash command although the policy denies bash (policy scope does not cover Monitor)');
  } finally { await host.close(); }
});

test('R03 supplement: a policy that inspects monitor_start source.command CAN block it (interception point exists)', { timeout: 90000 }, async () => {
  const file = 'marker-monitor-guarded.txt';
  const { host, seen } = await scenario('monitor-guarded', monitorCall(file), denyBashAndMonitorCommand);
  try {
    const ran = await waitFor(() => exists(join(sandbox.cwd, file)), 4000);
    console.error(`[R03] guarded: seen=${JSON.stringify(seen.map((s) => s.tool))} markerWritten=${ran}`);
    assert.equal(ran, false);
    assert.ok(seen.some((s) => s.tool === 'monitor_start' && s.input.source.command));
  } finally { await host.close(); }
});
