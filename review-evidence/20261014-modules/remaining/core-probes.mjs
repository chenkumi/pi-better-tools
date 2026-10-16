import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const out = resolve('review-evidence/20261014-modules/remaining');
const home = fs.mkdtempSync(join(tmpdir(), 'pi-review-core-'));
process.env.PI_CODING_AGENT_DIR = join(home, 'agent'); process.env.HOME = process.env.USERPROFILE = home;
process.env.PI_BLACKHOLE_PASSIVE = 'true';
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR); fs.writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), '{}'); fs.writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), '{}');
const { SessionManager } = await import('@earendil-works/pi-coding-agent');
const fork = await import('../../../modules/fork/src/manager.ts');
const { MonitorRuntime } = await import('../../../modules/monitor/src/core.ts');
const { FetchService } = await import('../../../modules/web-tools/src/fetch/service.ts');
const originalDeps = { ...fork.deps }, originalWrite = fs.writeFileSync;
const KEY = Symbol.for('pi-better-tools.fork.registry.v1');
const flush = () => new Promise(r => setImmediate(r));
const results = { samples: [], cleanup: false };
function origin(cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  const sm = SessionManager.create(cwd, join(cwd, 'sessions'));
  sm.appendMessage({ role: 'user', content: 'review fixture', timestamp: Date.now() });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'ready' }], api: 'openai-responses', provider: 'offline', model: 'fixture', stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const pi = { getActiveTools: () => ['read', 'fork'], getAllTools: () => [{ name: 'read', sourceInfo: { path: '/fixture/read.ts' } }, { name: 'fork', sourceInfo: { path: '/fixture/fork.ts' } }], getThinkingLevel: () => 'off', sendMessage: m => sm.appendCustomMessageEntry(m.customType, m.content, m.display, m.details) };
  const ctx = { cwd, sessionManager: sm, model: { provider: 'offline', id: 'fixture' }, isProjectTrusted: () => false, hasUI: false, ui: { setStatus() {} } };
  return { sm, pi, ctx };
}
try {
  for (let iteration = 1; iteration <= 3; iteration++) {
    console.log(`Progress: G1-003 partial prompt failure ${iteration}/3`);
    delete globalThis[KEY];
    const cwd = join(home, `partial-${iteration}`), { pi, ctx } = origin(cwd);
    fork.deps.argv = () => ['--system-prompt', 'first inline review prompt', '--append-system-prompt', 'second inline review prompt'];
    fork.deps.launchCwd = () => cwd;
    let prompts = 0, spawned = 0;
    fork.deps.startChild = () => { spawned++; throw new Error('Must not spawn'); };
    fs.writeFileSync = (...args) => {
      if (String(args[0]).endsWith('.prompt.txt') && ++prompts === 2) throw Object.assign(new Error('Injected second prompt write EIO'), { code: 'EIO' });
      return originalWrite(...args);
    };
    syncBuiltinESMExports();
    let error;
    try { fork.acceptFork(pi, ctx, { task: 'local review' }); } catch (e) { error = e.message; }
    finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
    const dir = join(cwd, '.pi/forks'), names = fs.readdirSync(dir);
    const leftover = names.filter(n => n.endsWith('.prompt.txt'));
    assert.match(error, /FORK_STORE_UNAVAILABLE/); assert.equal(spawned, 0);
    results.samples.push({ id: 'G1-003', iteration, seam: 'real SessionManager, acceptFork, fs writes; second prompt EIO injection', error, orphanPromptCount: leftover.length, orphanContents: leftover.map(n => fs.readFileSync(join(dir, n), 'utf8')), metadataCount: names.filter(n => n.endsWith('.json')).length, registryJobs: fork.state().jobs.size, spawned });
    console.log(`Progress: G1-002 pending manager retention ${iteration}/3`);
    delete globalThis[KEY]; fork.deps.argv = () => [];
    let finish;
    fork.deps.startChild = () => ({ done: new Promise(r => finish = r), async cancel() {} });
    const pendingCwd = join(home, `retention-${iteration}`);
    let maxActive = 0;
    for (let n = 0; n < 65; n++) {
      const A = origin(pendingCwd);
      fork.onSessionStart(A.pi, A.ctx);
      fork.acceptFork(A.pi, A.ctx, { task: `bounded task ${n}` });
      maxActive = Math.max(maxActive, fork.activeCount());
      fork.onTurnEnd(A.ctx);
      await fork.onSessionShutdown('new');
      const B = origin(pendingCwd); fork.onSessionStart(B.pi, B.ctx);
      finish({ status: 'completed', output: 'bounded result', childClosed: true, exitCode: 0, stderrTail: '' });
      await flush();
    }
    results.samples.push({ id: 'G1-002', iteration, seam: 'real admission/snapshot/store/session replacement with controlled child outcome; no real children', admitted: 65, retained: fork.state().jobs.size, pending: [...fork.state().jobs.values()].filter(j => j.record.delivery === 'pending').length, maxActive, activeAfter: fork.activeCount(), documentedRetained: 32 });
    console.log(`Progress: G3-001 wall-clock jump ${iteration}/3`);
    for (const offset of [0, -600000]) {
      let now = 1000000, next = 0, sink, close;
      const timers = new Map();
      const clock = { now: () => now, set: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }, clear: id => timers.delete(id) };
      const sent = [], runtime = new MonitorRuntime(m => sent.push(m), clock), owner = { sessionId: 'CLOCK', cwd: pendingCwd };
      runtime.bind(owner, () => owner);
      const receipt = runtime.start({ source: { kind: 'command', tool: 'powershell', command: 'fixture' }, durationMs: 1200000, wakeAgent: false }, async s => { sink = s; s.started(); await new Promise(r => close = () => { s.closed({ fixtureClosed: true }); r(); }); });
      await Promise.resolve();
      const initial = [...timers].find(([, v]) => v.ms === 0); assert(initial);
      timers.delete(initial[0]); initial[1].fn();
      assert.equal(sent.length, 1);
      now += offset; sink.data('later data');
      const delay = [...timers.values()].filter(t => t.ms !== 1200000).map(t => t.ms);
      const status = runtime.status(receipt.monitorId);
      results.samples.push({ id: 'G3-001', iteration, clockOffsetMs: offset, schedulingDelays: delay, elapsedMs: status.elapsedMs, buffered: status.buffered, firstBatchSubmitted: sent.length });
      close(); await runtime.settled(receipt.monitorId); await runtime.shutdown(); assert.equal(timers.size, 0);
    }
    console.log(`Progress: G3-002 real browser cleanup fault ${iteration}/3`);
    const service = new FetchService({ channel: 'chromium', timeoutMs: 10000, maxConcurrency: 1, idleTimeoutMs: 60000 });
    let browser, originalClose, restored = false;
    try {
      try { browser = await service.getBrowser(); }
      catch (e) { results.samples.push({ id: 'G3-002', iteration, blocked: e.message }); await service.close(); break; }
      originalClose = browser.close.bind(browser);
      browser.close = async () => { throw new Error('Injected transport close rejection before disconnect'); };
      let resolved = false, error;
      try { await service.close(); resolved = true; } catch (e) { error = e.message; }
      const stillConnected = browser.isConnected();
      const context = await browser.newContext(); await context.close();
      results.samples.push({ id: 'G3-002', iteration, seam: 'real product-launched Chromium; owned close rejection injection', serviceCloseResolved: resolved, serviceCloseError: error, stillConnected, canCreateContextAfterServiceClose: true, serviceHasBrowserOwner: service.browser !== undefined, retainedClosingPromises: service.closingBrowsers.size });
    } finally {
      if (browser && originalClose) { browser.close = originalClose; await originalClose(); restored = true; assert.equal(browser.isConnected(), false); }
      await service.close();
      const last = results.samples.at(-1); if (last?.id === 'G3-002') last.originalCloseCleanupConfirmed = restored;
    }
    await fsp.writeFile(join(out, 'core-results.json'), JSON.stringify(results, null, 2));
  }
} finally {
  Object.assign(fork.deps, originalDeps); delete globalThis[KEY]; fs.writeFileSync = originalWrite; syncBuiltinESMExports();
  fs.rmSync(home, { recursive: true, force: true }); results.cleanup = true;
  await fsp.writeFile(join(out, 'core-results.json'), JSON.stringify(results, null, 2));
}
console.log(`Progress: core probes complete, ${results.samples.length} samples`);
