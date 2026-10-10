// R02 (a): the project-agent approval dialog (ctx.ui.confirm) is opened WITHOUT the tool signal, so aborting the tool leaves
//          the dialog open and a late approval can still dispatch.
// R02 (b) (contract test, asserts current host behaviour): child-bridge enforces the ready-query "no mainline" rule by throwing in before_agent_start; Pi's runner catches the
//          error and continues, so the throw is not an admission barrier.
// Level: real Pi 1.1.0 AgentSession + real subagents module/child-bridge entries + real agent loop and extension runner.
// The dialog is a controllable UI stand-in that closes on opts.signal exactly like an interactive dialog should (if a signal is passed).
// Safety: PI_SUBAGENTS_PI_CLI is a stub that records a marker instead of starting Pi; no provider is ever contacted.
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { barrier, createHost, entry, heartbeat, isolate, log, turns } from '../../../tests/helpers/regression/host.mjs';

test('R02 (a): aborting the tool while the project-agent confirm is open must close the dialog and never dispatch on late approval', { timeout: 120000 }, async () => {
  const env = await isolate('r02a-sub'); const stop = heartbeat('R02a'); const gate = barrier(); let host; const dialogs = [];
  try {
    const marker = join(env.home, 'CHILD_SPAWNED'); const stub = join(env.home, 'stub-pi.mjs');
    await writeFile(stub, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.exit(1);\n`);
    process.env.PI_SUBAGENTS_PI_CLI = stub;
    await mkdir(join(env.cwd, '.pi', 'agents'), { recursive: true });
    await writeFile(join(env.cwd, '.pi', 'agents', 'proj.md'), '---\nname: proj\ndescription: project-local test agent\n---\nYou are a test agent.\n');
    const noop = () => {};
    const ui = new Proxy({ confirm(title, message, opts) {
      return new Promise(resolve => {
        const dialog = { title, opts, resolve, closedBySignal: false };
        opts?.signal?.addEventListener('abort', () => { dialog.closedBySignal = true; resolve(false); }, { once: true });
        dialogs.push(dialog); gate.poke();
      });
    } }, { get: (target, key) => (key in target ? target[key] : key === 'then' ? undefined : noop) });
    host = await createHost({ env, uiContext: ui, extensionPaths: [entry('modules/subagents/src/index.ts')] });
    await host.bind(); assert.deepEqual(host.loadErrors(), []);
    log('dispatching a project-local agent in an untrusted project; the approval dialog must open');
    const run = host.callTools({ name: 'subagent', arguments: { agent: 'proj', task: 'noop', agentScope: 'project' } });
    let early; run.then(r => { early = r; }); await gate.wait(() => dialogs.length > 0 || early, 'project-agent confirm dialog opened', 15000).catch(error => { log('run result: ' + JSON.stringify(early?.map(r => r.content))); throw error; });
    assert.ok(dialogs.length > 0, 'precondition: dialog opened; tool returned ' + JSON.stringify(early?.map(r => r.content)));
    const dialog = dialogs[0];
    log('aborting the agent run (tool signal) while the dialog is open');
    const aborting = host.session.abort();
    await turns(200);
    const failures = [];
    if (!dialog.opts?.signal) failures.push('confirm() was opened without the tool AbortSignal (opts=' + JSON.stringify(dialog.opts ?? null) + ')');
    else if (!dialog.opts.signal.aborted) failures.push('the signal passed to confirm() was not aborted');
    if (!dialog.closedBySignal) failures.push('dialog was not closed by the abort; it stays open');
    log('late approval arrives after the abort');
    dialog.resolve(true);
    await Promise.race([Promise.all([run, aborting]), new Promise((_, reject) => setTimeout(() => reject(new Error('run did not settle after approval')), 30000).unref())]);
    const dispatched = await access(marker).then(() => true, () => false);
    if (dispatched) failures.push('late approval after abort still dispatched the project agent (child spawn attempted)');
    assert.equal(failures.length, 0, failures.join('; '));
  } finally {
    delete process.env.PI_SUBAGENTS_PI_CLI; for (const dialog of dialogs) dialog.resolve(false);
    try { await host?.close(); } catch { /* ignore */ }
    stop(); await env.cleanup();
  }
});

test('R02 (b) contract: throwing in before_agent_start is NOT an admission barrier (host catches and continues); real protection is --no-tools/--exclude-tools', { timeout: 120000 }, async () => {
  const env = await isolate('r02b-sub'); const stop = heartbeat('R02b'); let host; const realSend = process.send;
  try {
    // Same preconditions child-bridge checks at load: a guard expectation with a ready-query snapshot, and an IPC channel.
    globalThis.__piSubagentsGuardExpected = { bridgeToken: 'defect-repro-token', readyQuerySnapshot: { path: join(env.home, 'none'), hash: '0' } };
    process.send = () => true;
    host = await createHost({ env, extensionPaths: [entry('modules/subagents/extensions/subagent/child-bridge.ts')] });
    await host.bind(); assert.deepEqual(host.loadErrors(), []);
    let rejected;
    try { await host.session.prompt('this prompt must not reach the model in a disposable ready-query child', { expandPromptTemplates: false }); } catch (error) { rejected = error; }
    const hookErrors = host.errors.map(e => String(e?.message ?? e));
    log(`prompt rejected=${Boolean(rejected)}; hook errors=${JSON.stringify(hookErrors)}; provider calls=${host.state.calls}`);
    assert.ok(hookErrors.some(m => /QUERY_MAINLINE_FORBIDDEN/.test(m)) || rejected, 'precondition: the guard did fire');
    // Contract documentation, not a production defect: Pi 1.1.0 catches before_agent_start errors and continues the turn, so the
    // throw only reports. The actual ready-query protection is the child's --no-tools / --exclude-tools argument set (see child-args.test.ts),
    // not this hook. Do not rely on the throw as a security barrier; if Pi ever starts aborting the prompt, update this assertion.
    assert.equal(host.state.calls, 1, `host contract changed: expected the runner to continue after the hook error (model calls=${host.state.calls})`);
  } finally {
    delete globalThis.__piSubagentsGuardExpected; if (realSend) process.send = realSend; else delete process.send;
    try { await host?.close(); } catch { /* ignore */ }
    stop(); await env.cleanup();
  }
});
