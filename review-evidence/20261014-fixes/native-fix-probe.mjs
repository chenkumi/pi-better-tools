import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const out = resolve('review-evidence/20261014-fixes'), src = resolve('review-evidence/20261014-modules/remaining');
const root = await fs.mkdtemp(join(tmpdir(), 'pi-review-native-'));
process.env.TEMP = process.env.TMP = root;
process.env.HOME = process.env.USERPROFILE = root; process.env.PI_CODING_AGENT_DIR = join(root, 'agent'); process.env.PI_BLACKHOLE_PASSIVE = 'true';
await fs.mkdir(process.env.PI_CODING_AGENT_DIR); await fs.writeFile(join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), '{}'); await fs.writeFile(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), '{}');
const { startForkChild } = await import('../../modules/fork/src/child.ts');
const { SessionManager } = await import('@earendil-works/pi-coding-agent');
const { default: shellExtension } = await import('../../modules/shell-tools/extensions/timeout-ms.ts');
const rpcOnly = process.argv.includes('--rpc-only');
const resultPath = join(out, rpcOnly ? 'native-current-rpc-results.json' : 'native-fix-results.json');
const { createHash } = await import('node:crypto');
const forkPaths = ['child.ts', 'child-guard.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(forkPaths.map(async name => [name, createHash('sha256').update(await fs.readFile(resolve('modules/fork/src', name))).digest('hex')])));
const results = { samples: [], cleanup: false, rpcOnly, sourceHashesBefore: await hashes() };
await fs.writeFile(resultPath, JSON.stringify(results, null, 2));
let activeHandle;
try {
  for (let iteration = 1; iteration <= 3; iteration++) {
    for (const mode of ['cancel-at-stats', 'normal', 'cancel-before-verified']) {
      console.log(`Progress: G1-004 native RPC ${mode} ${iteration}/3`);
      const cwd = join(root, `rpc-${iteration}-${mode}`); await fs.mkdir(cwd);
      let handle, cancelRequested = false, nativeClose = false;
      handle = startForkChild({ jobId: 'REVIEW', sessionId: 'SOURCE', sessionPath: join(cwd, 'unused.jsonl'), sessionDir: cwd, cwd, model: 'offline/fixture', thinkingLevel: 'off', tools: [], trusted: false, guardPath: join(out, 'unused.ts'), forwarded: [], prompt: 'safe standalone protocol fixture',
        invocation: () => ({ command: process.execPath, args: [join(src, 'rpc-child.mjs'), mode] }),
        spawnImpl: (command, args, options) => {
          const child = spawn(command, args, options);
          child.on('close', () => nativeClose = true);
          child.on('message', m => { if (m?.channel === 'review-stats-barrier') { cancelRequested = true; void handle.cancel(); } });
          return child;
        }
      });
      activeHandle = handle;
      if (mode === 'cancel-before-verified') { cancelRequested = true; await handle.cancel(); }
      const outcome = await handle.done; activeHandle = undefined;
      const observed = await fs.readFile(join(cwd, 'rpc-observed.jsonl'), 'utf8').catch(e => e.code === 'ENOENT' ? '' : Promise.reject(e));
      const commands = observed.trim() ? observed.trim().split('\n').map(x => JSON.parse(x).type) : [];
      assert(outcome.childClosed && nativeClose);
      results.samples.push({ id: 'G1-004', iteration, mode, seam: 'real Node OS child with Pi RPC stand-in; actual product startForkChild/RpcPipe, no Pi/model in child', cancelRequested, promptActuallyReceived: commands.includes('prompt'), commands, outcome, nativeClose });
    }
    if (rpcOnly) { await fs.writeFile(resultPath, JSON.stringify(results, null, 2)); continue; }
    console.log(`Progress: G2-001 real shell handoff ${iteration}/3`);
    const cwd = join(root, `shell-${iteration}`); await fs.mkdir(cwd);
    const sm = SessionManager.create(cwd, join(cwd, 'sessions'));
    sm.appendMessage({ role: 'user', content: 'review', timestamp: Date.now() });
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'review' }], api: 'openai-responses', provider: 'offline', model: 'fixture', stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const hooks = new Map(), tools = new Map();
    let notifyFinished;
    const finished = new Promise(r => notifyFinished = r);
    const pi = { registerTool: t => tools.set(t.name, t), registerMessageRenderer() {}, registerCommand() {}, registerToolRenderer() {}, on: (name, fn) => { const arr = hooks.get(name) ?? []; arr.push(fn); hooks.set(name, arr); return () => {}; }, sendMessage: m => { if (m.customType === 'shell-job-completed') notifyFinished(m); }, appendEntry: (type, data) => sm.appendCustomEntry(type, data), getActiveTools: () => ['powershell', 'shell_job_status', 'shell_job_cancel'], getSettings: () => ({ 'pi-shell-tools': { autoBackgroundMs: 47001 } }), events: { on() { return () => {}; }, emit() {} } };
    shellExtension(pi);
    const ctx = { cwd, hasUI: false, mode: 'print', ui: {}, sessionManager: sm, signal: undefined, isIdle: () => true, isProjectTrusted: () => true };
    for (const fn of hooks.get('session_start') ?? []) await fn({}, ctx);
    const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
    let adopt, fakeTimer;
    globalThis.setTimeout = (fn, ms, ...args) => { if (ms === 47001) { adopt = () => fn(...args); fakeTimer = { reviewHandoffTimer: true }; return fakeTimer; } return realSet(fn, ms, ...args); };
    globalThis.clearTimeout = h => { if (h !== fakeTimer) realClear(h); };
    let receipt, triggered = false;
    try {
      const quote = s => `'${s.replaceAll("'", "''")}'`;
      const command = `& ${quote(process.execPath)} ${quote(join(src, 'output-child.mjs'))} ${quote(cwd)}`;
      receipt = await tools.get('powershell').execute(`native-${iteration}`, { command }, undefined, update => {
        const text = update.content?.map(b => b.text ?? '').join('') ?? '';
        if (!triggered && text.length >= 48 * 1024 && adopt) { triggered = true; queueMicrotask(adopt); }
      }, ctx);
      assert(triggered && receipt.structuredContent?.jobId, 'controlled callback must adopt actual running process');
      await fs.writeFile(join(cwd, 'finish.signal'), 'finish');
      await finished;
      const status = (await tools.get('shell_job_status').execute('status', { jobId: receipt.structuredContent.jobId }, undefined, undefined, ctx)).structuredContent;
      const outputBytes = Buffer.byteLength(status.output ?? ''), tailBytes = Buffer.byteLength(status.outputTail ?? '');
      assert.equal(status.status, 'completed'); assert.equal(status.exitCode, 0);
      results.samples.push({ id: 'G2-001', iteration, seam: 'real registered powershell, real host accumulator and local child; product auto-handoff timer callback invoked at full-output event', triggered, pid: Number(await fs.readFile(join(cwd, 'owned-child.pid'), 'utf8')), outputBytes, tailBytes, totalRetainedOutputBytes: outputBytes + tailBytes, documentedCap: 32768, actualBackendComplete: true, singleHelperPid: true, logBytes: status.logBytes });
      for (const fn of hooks.get('session_shutdown') ?? []) await fn({ reason: 'quit' }, ctx);
      await fs.rm(dirname(status.logPath), { recursive: true, force: true });
    } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
    await fs.writeFile(resultPath, JSON.stringify(results, null, 2));
  }
} finally {
  if (activeHandle) { await activeHandle.cancel(); await activeHandle.done; }
  await fs.rm(root, { recursive: true, force: true }); results.cleanup = true;
  results.sourceHashesAfter = await hashes(); results.sourceStable = JSON.stringify(results.sourceHashesBefore) === JSON.stringify(results.sourceHashesAfter); if (!results.sourceStable) process.exitCode = 1;
  await fs.writeFile(resultPath, JSON.stringify(results, null, 2));
}
console.log(`Progress: native probes complete, ${results.samples.length} samples`);
