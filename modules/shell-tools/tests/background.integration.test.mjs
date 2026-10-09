import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import extension from '../extensions/timeout-ms.ts';
import { SHELL_WIDGET_KEY } from '../src/live-widget.ts';
import { createPiFixture } from './helpers/pi-fixture.mjs';

let fixture, heartbeat;
before(async () => {
  heartbeat = setInterval(() => console.log('Shell background event-coordinated verification in progress...'), 5000);
  fixture = await createPiFixture();
});
after(() => { clearInterval(heartbeat); fixture?.cleanup(); });
const names = process.platform === 'win32' ? ['bash', 'powershell'] : ['bash'];

function fakeHost(cwd) {
  const tools = new Map(), handlers = new Map(), messages = [], widgets = new Map(), statuses = new Map(), commands = new Map(), renderers = new Map();
  const theme = { fg: (_, text) => text, bg: (_, text) => text, getBgAnsi: () => '' };
  let resolveCompletion;
  let settings = { shellCommandPrefix: 'export BG_PREFIX=effective' };
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerMessageRenderer(type, renderer) { assert.equal(typeof renderer, 'function'); renderers.set(type, renderer); },
    on(event, handler) { handlers.set(event, handler); },
    getSettings() { return settings; },
    sendMessage(message, options) { messages.push({ message, options }); resolveCompletion?.({ message, options }); },
  };
  extension(pi);
  assert.deepEqual([...renderers.keys()].sort(), ['background-runtime-recovery-shell', 'shell-job-completed']);
  const ctx = { cwd, mode: 'tui', hasUI: true, isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus(key, value) { if (value) statuses.set(key, value); else statuses.delete(key); }, setWidget(key, value) { if (value) widgets.set(key, value); else widgets.delete(key); } }, sessionManager: { getSessionId: () => 'fake-owner', getSessionFile: () => undefined }, model: { provider: 'fake', id: 'fake' }, thinkingLevel: 'off' };
  handlers.get('session_start')({}, ctx);
  return {
    tools, messages, ctx, widgets, statuses,
    panel: () => widgets.get(SHELL_WIDGET_KEY)?.({}, theme).render(100).join('\n') ?? statuses.get(SHELL_WIDGET_KEY) ?? '',
    expand() { void commands.get('background-jobs').handler('shell', ctx); },
    setSettings: value => { settings = value; },
    execute: (name, input, signal) => tools.get(name).execute('fake-call', input, signal, undefined, ctx),
    completion: () => new Promise(resolve => { resolveCompletion = resolve; }),
    shutdown: reason => handlers.get('session_shutdown')({ reason }, ctx),
  };
}

function waitForFile(file) {
  if (fs.existsSync(file)) return Promise.resolve();
  return new Promise(resolve => {
    const watcher = fs.watch(path.dirname(file), () => {
      if (fs.existsSync(file)) { watcher.close(); resolve(); }
    });
    if (fs.existsSync(file)) { watcher.close(); resolve(); }
  });
}
function nodeCommand(name, script) {
  return name === 'bash' ? `node '${path.basename(script)}'` : `node '${path.basename(script)}'; exit $LASTEXITCODE`;
}
function gateScript(cwd) {
  const script = path.join(cwd, 'gate.cjs');
  const ready = path.join(cwd, 'ready');
  const gate = path.join(cwd, 'gate');
  fs.writeFileSync(script, `const fs = require('node:fs');
const watcher = fs.watch('.', () => { if (fs.existsSync('gate')) { watcher.close(); process.stdout.write('FINISHED\\n'); } });
process.stdout.write('READY ' + (process.env.BG_PREFIX || 'none') + '\\n', () => fs.writeFileSync('ready', String(process.pid)));
`);
  return { script, ready, gate };
}

test('real local shells return readable receipts, allow foreground work, detach turn abort and followUp after completion', { timeout: 60000 }, async () => {
  for (const name of names) {
    const cwd = fs.mkdtempSync(path.join(fixture.temp, 'bg-workspace-'));
    const host = fakeHost(cwd);
    const { script, ready, gate } = gateScript(cwd);
    const turn = new AbortController();
    try {
      assert.ok([...host.tools.values()].every(tool => tool.defaultActive === false));
      const completion = host.completion();
      const readyEvent = waitForFile(ready);
      assert.match(host.tools.get(name).description, /need explicit selection/);
      assert.ok(!host.tools.get(name).description.includes('2147483647'));
      assert.ok(!host.tools.get(name).parameters.properties.timeoutMs.description.includes('2147483647'));
      assert.match(host.tools.get(name).parameters.properties.timeoutMs.description, /Not a total time limit/);
      assert.match(host.tools.get(name).description, name === 'bash' ? /Git Bash/ : /shellCommandPrefix is not applied/);
      const accepted = await host.execute(name, { command: nodeCommand(name, script), background: true }, turn.signal);
      assert.match(accepted.content[0].text, /read log tail/i);
      assert.match(accepted.content[0].text, /shell_job_status\/cancel not selected/);
      const notice = 'Background job accepted; its outcome will be reported when it finishes.\n';
      assert.ok(accepted.content[0].text.startsWith(notice));
      assert.ok(accepted.content[0].text.slice(notice.length).length < 260, 'the existing receipt payload remains slim');
      const receipt = accepted.structuredContent;
      assert.equal(host.widgets.has(SHELL_WIDGET_KEY), false, 'collapsed work uses footer status only'); assert.match(host.panel(), /Shell：1/); assert.equal(host.panel().split('\n').length, 1); assert.ok(!host.panel().includes('gate.cjs')); host.expand();
      assert.match(host.panel(), /1 active/); assert.match(host.panel(), new RegExp(name)); assert.match(host.panel(), /gate.cjs/);
      host.setSettings({ shellCommandPrefix: 'export BG_PREFIX=changed-after-receipt' });
      assert.equal(receipt.status, 'running');
      assert.ok(!('exit_code' in receipt));
      assert.equal(fs.existsSync(receipt.liveLogPath), true);
      await readyEvent;
      turn.abort();
      const running = (await host.execute('shell_job_status', { jobId: receipt.jobId })).structuredContent;
      assert.equal(running.status, 'running');
      assert.equal(running.command, nodeCommand(name, script));
      assert.equal(typeof running.elapsedMs, 'number');
      const listed = (await host.execute('shell_job_status', {})).structuredContent;
      assert.deepEqual(listed.jobs.map(job => job.jobId), [receipt.jobId]);
      assert.match(fs.readFileSync(receipt.liveLogPath, 'utf8'), /READY/);
      const foreground = await host.execute(name, { command: name === 'bash' ? 'printf FOREGROUND' : 'Write-Output FOREGROUND' });
      assert.match(foreground.structuredContent.output, /FOREGROUND/);
      assert.equal(foreground.structuredContent.exit_code, 0);
      fs.writeFileSync(gate, 'release');
      const notification = await completion;
      assert.equal(host.widgets.has(SHELL_WIDGET_KEY), false, 'completion removes the live widget before followUp');
      assert.equal(host.statuses.has(SHELL_WIDGET_KEY), false, 'completion also clears the footer summary');
      assert.deepEqual(notification.options, { triggerTurn: true, deliverAs: 'followUp' });
      const finalResult = await host.execute('shell_job_status', { jobId: receipt.jobId });
      const final = finalResult.structuredContent;
      const finalText = JSON.parse(finalResult.content[0].text);
      assert.equal(finalText.status, 'completed');
      assert.match(finalText.output, /FINISHED/);
      for (const noise of ['cancelRequested', 'logPath', 'liveLogPath', 'toolCallId', 'command', 'outputTail', 'logBytes']) assert.ok(!(noise in finalText), noise);
      assert.equal(final.status, 'completed');
      assert.equal(final.exitCode, 0);
      assert.match(final.output, /FINISHED/);
      assert.match(final.output, name === 'bash' ? /READY effective/ : /READY none/);
      assert.equal(final.logPath, receipt.liveLogPath);
      assert.match(fs.readFileSync(final.logPath, 'utf8'), /FINISHED/);
    } finally { await host.shutdown('quit'); }
  }
});

test('real shell cancellation and every shutdown reason terminate accepted work without stale notifications', { timeout: 60000 }, async () => {
  for (const name of names) for (const reason of ['cancel', 'quit', 'reload', 'new', 'resume', 'fork']) {
    const cwd = fs.mkdtempSync(path.join(fixture.temp, 'bg-cancel-'));
    const host = fakeHost(cwd);
    const { script, ready } = gateScript(cwd);
    let receipt;
    try {
      const readyEvent = waitForFile(ready);
      receipt = (await host.execute(name, { command: nodeCommand(name, script), background: true })).structuredContent;
      await readyEvent;
      if (reason === 'cancel') {
        const completion = host.completion();
        const requested = (await host.execute('shell_job_cancel', { jobId: receipt.jobId })).structuredContent;
        assert.equal(requested.status, 'cancelling');
        await completion;
        const final = (await host.execute('shell_job_status', { jobId: receipt.jobId })).structuredContent;
        assert.equal(final.status, 'cancelled');
        assert.ok(!('exitCode' in final));
      } else {
        await host.shutdown(reason);
        assert.equal(host.widgets.has(SHELL_WIDGET_KEY), false, 'all shutdown reasons clear the live widget');
        assert.equal(host.messages.length, 0);
        assert.equal(fs.existsSync(receipt.liveLogPath), false);
      }
      const pid = Number(fs.readFileSync(ready, 'utf8'));
      assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i, `${name}/${reason} direct child must have exited`);
    } finally { await host.shutdown('quit'); }
    assert.equal(fs.existsSync(receipt.liveLogPath), false);
  }
});

test('invalid UTF8 flood keeps decoded host output bounded and creates no external pi-bash temp file', { timeout: 60000 }, async () => {
  for (const name of names) {
    const cwd = fs.mkdtempSync(path.join(fixture.temp, 'bg-invalid-utf8-'));
    const host = fakeHost(cwd);
    const script = path.join(cwd, 'invalid.cjs');
    fs.writeFileSync(script, "process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 255));");
    const before = fs.readdirSync(fixture.outputDir).sort();
    let receipt;
    try {
      const completion = host.completion();
      receipt = (await host.execute(name, { command: nodeCommand(name, script), background: true })).structuredContent;
      await completion;
      const result = (await host.execute('shell_job_status', { jobId: receipt.jobId })).structuredContent;
      assert.equal(result.status, 'completed');
      assert.equal(result.exitCode, 0);
      assert.equal(result.outputTruncated, true);
      assert.ok(Buffer.byteLength(result.output, 'utf8') <= 32768, name);
      if (name === 'bash') assert.equal(result.output, '\uFFFD'.repeat(Math.floor((32768 - 8192) / 3)));
      assert.ok(Buffer.byteLength(result.outputTail, 'utf8') <= 8192);
      assert.equal(fs.statSync(receipt.liveLogPath).size, 1024 * 1024);
      // OutputAccumulator must never produce its own pi-bash-/pi-powershell-
      // temp file: their decoded truncation thresholds must not be reached.
      assert.deepEqual(fs.readdirSync(fixture.outputDir).filter(file => !file.startsWith('pi-shell-job-')).sort(), before);
    } finally { await host.shutdown('quit'); }
    assert.equal(fs.existsSync(receipt.liveLogPath), false);
    assert.deepEqual(fs.readdirSync(fixture.outputDir).sort(), before, 'shutdown removes the only background log directory');
  }
});

test('background flood consumes output without unbounded host files, preserves UTF8/nonzero result and debug logging', { timeout: 60000 }, async () => {
  fixture.writeDebugSettings({ 'pi-shell-tools': { debugLog: true } });
  try {
    for (const name of names) {
      const cwd = fs.mkdtempSync(path.join(fixture.temp, 'bg-flood-'));
      const host = fakeHost(cwd);
      const script = path.join(cwd, 'flood.cjs');
      fs.writeFileSync(script, "process.stdout.write('繁體中文\\n' + 'x\\n'.repeat(600000)); process.exitCode = 7;");
      const before = fs.readdirSync(fixture.outputDir).filter(file => !file.startsWith('pi-shell-job-'));
      try {
        const completed = host.completion();
        const receipt = (await host.execute(name, { command: nodeCommand(name, script), background: true })).structuredContent;
        await completed;
        const final = (await host.execute('shell_job_status', { jobId: receipt.jobId })).structuredContent;
        assert.equal(final.status, 'failed');
        assert.equal(final.exitCode, 7, name);
        assert.equal(final.outputTruncated, true);
        assert.match(final.output, /繁體中文/);
        assert.ok(Buffer.byteLength(final.output) <= 32768);
        assert.equal(fs.statSync(final.logPath).size, 1024 * 1024);
        assert.deepEqual(fs.readdirSync(fixture.outputDir).filter(file => !file.startsWith('pi-shell-job-')), before);
        const logDir = path.join(fixture.homeDir, '.pi', 'logs', 'pi-shell-tools');
        const records = fs.readdirSync(logDir).map(file => JSON.parse(fs.readFileSync(path.join(logDir, file), 'utf8')));
        assert.ok(records.some(record => record.tool === name && record.input.background === true && record.failure.result.structuredContent.exit_code === 7));
      } finally { await host.shutdown('quit'); }
    }
  } finally { fixture.writeDebugSettings({}); }
});

test('status of a running job shows only the last 2000 tail characters in model text while structuredContent keeps the full tail', { timeout: 60000 }, async () => {
  for (const name of names) {
    const cwd = fs.mkdtempSync(path.join(fixture.temp, 'bg-tail-'));
    const host = fakeHost(cwd);
    const script = path.join(cwd, 'flood.cjs');
    const ready = path.join(cwd, 'ready'), gate = path.join(cwd, 'gate');
    fs.writeFileSync(script, `const fs = require('node:fs');
const watcher = fs.watch('.', () => { if (fs.existsSync('gate')) { watcher.close(); process.stdout.write('DONE\\n'); } });
process.stdout.write('A'.repeat(6000) + '\\n', () => fs.writeFileSync('ready', String(process.pid)));
`);
    try {
      const completion = host.completion();
      const readyEvent = waitForFile(ready);
      const accepted = await host.execute(name, { command: nodeCommand(name, script), background: true });
      await readyEvent;
      const result = await host.execute('shell_job_status', { jobId: accepted.structuredContent.jobId });
      assert.equal(result.structuredContent.status, 'running');
      assert.ok(result.structuredContent.outputTail.length >= 6000, 'structuredContent keeps the whole tail');
      const text = JSON.parse(result.content[0].text);
      assert.equal(text.status, 'running');
      assert.ok(text.outputTail.length <= 2000, `model text tail is at most 2000 chars, got ${text.outputTail.length}`);
      assert.ok(/^A+\s*$/.test(text.outputTail), 'the clipped tail is the most recent output');
      fs.writeFileSync(gate, 'release');
      await completion;
    } finally { await host.shutdown('quit'); }
  }
});
