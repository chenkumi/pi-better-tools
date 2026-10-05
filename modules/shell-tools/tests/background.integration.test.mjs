import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import extension from '../extensions/timeout-ms.ts';
import { createPiFixture } from './helpers/pi-fixture.mjs';

let fixture, heartbeat;
before(async () => {
  heartbeat = setInterval(() => console.log('Shell background event-coordinated verification in progress...'), 5000);
  fixture = await createPiFixture();
});
after(() => { clearInterval(heartbeat); fixture?.cleanup(); });
const names = process.platform === 'win32' ? ['bash', 'powershell'] : ['bash'];

function fakeHost(cwd) {
  const tools = new Map(), handlers = new Map(), messages = [];
  let resolveCompletion;
  let settings = { shellCommandPrefix: 'export BG_PREFIX=effective' };
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    on(event, handler) { handlers.set(event, handler); },
    getSettings() { return settings; },
    sendMessage(message, options) { messages.push({ message, options }); resolveCompletion?.({ message, options }); },
  };
  extension(pi);
  const ctx = { cwd, sessionManager: { getSessionId: () => 'fake-owner', getSessionFile: () => undefined }, model: { provider: 'fake', id: 'fake' }, thinkingLevel: 'off' };
  handlers.get('session_start')({}, ctx);
  return {
    tools, messages, ctx,
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
      assert.match(host.tools.get(name).description, /inactive unless explicitly selected/);
      const accepted = await host.execute(name, { command: nodeCommand(name, script), background: true }, turn.signal);
      assert.match(accepted.content[0].text, /Management requires explicitly selected/);
      assert.match(accepted.content[0].text, /shell-only loadouts cannot request job cancellation/);
      const receipt = accepted.structuredContent;
      host.setSettings({ shellCommandPrefix: 'export BG_PREFIX=changed-after-receipt' });
      assert.equal(receipt.status, 'running');
      assert.ok(!('exit_code' in receipt));
      assert.equal(fs.existsSync(receipt.liveLogPath), true);
      await readyEvent;
      turn.abort();
      const running = (await host.execute('shell_job_status', { jobId: receipt.jobId })).structuredContent;
      assert.equal(running.status, 'running');
      assert.match(fs.readFileSync(receipt.liveLogPath, 'utf8'), /READY/);
      const foreground = await host.execute(name, { command: name === 'bash' ? 'printf FOREGROUND' : 'Write-Output FOREGROUND' });
      assert.match(foreground.structuredContent.output, /FOREGROUND/);
      assert.equal(foreground.structuredContent.exit_code, 0);
      fs.writeFileSync(gate, 'release');
      const notification = await completion;
      assert.deepEqual(notification.options, { triggerTurn: true, deliverAs: 'followUp' });
      const final = (await host.execute('shell_job_status', { jobId: receipt.jobId })).structuredContent;
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
      if (name === 'bash') assert.equal(result.output, '\uFFFD'.repeat(Math.floor(32768 / 3)));
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
