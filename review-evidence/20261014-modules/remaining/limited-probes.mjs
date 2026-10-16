import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const out = resolve('review-evidence/20261014-modules/remaining');
const home = await fs.mkdtemp(join(tmpdir(), 'pi-review-limited-'));
process.env.HOME = process.env.USERPROFILE = home; process.env.PI_CODING_AGENT_DIR = join(home, 'agent'); process.env.PI_BLACKHOLE_PASSIVE = 'true';
await fs.mkdir(process.env.PI_CODING_AGENT_DIR); await fs.writeFile(join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), '{}'); await fs.writeFile(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), '{}');
const { CronStorage } = await import('../../../modules/schedule-prompt/src/storage.ts');
const { CronScheduler } = await import('../../../modules/schedule-prompt/src/scheduler.ts');
const { ulid } = await import('ulid');
const results = { samples: [], cleanup: false, evidenceLimit: 'Unit fault injection/limited load only; not real native close-unconfirmed, OM hook rate or resource exhaustion proof' };
const originalAppend = fs.appendFile, originalSetInterval = globalThis.setInterval;
let tick;
try {
  globalThis.setInterval = (fn, ms, ...args) => { if (ms === 1000) { tick = () => fn(...args); return { unref() {} }; } return originalSetInterval(fn, ms, ...args); };
  const logger = await import('../../../modules/blackhole/src/om/debug-log.ts');
  for (let iteration = 1; iteration <= 3; iteration++) {
    console.log(`Progress: G5-003 limited shutdown outcome propagation ${iteration}/3`);
    const cwd = join(home, `scheduler-${iteration}`); await fs.mkdir(cwd);
    const storage = new CronStorage(cwd), sent = [], emitted = [];
    const ctx = { cwd, sessionManager: { getSessionId: () => 'REVIEW' }, isProjectTrusted: () => true };
    const scheduler = new CronScheduler(storage, { sendMessage: m => sent.push(m), events: { emit: (_type, event) => emitted.push(event) } }, ctx);
    const job = { id: ulid().toUpperCase(), name: 'limited shutdown', type: 'interval', schedule: '1h', intervalMs: 3600000, command: 'no native process is spawned in this probe', enabled: true, createdAt: new Date().toISOString(), session: 'REVIEW' };
    storage.addJob(job);
    let enter;
    const started = new Promise(r => enter = r);
    scheduler.runCommand = async (_command, _shell, _cwd, _timeout, signal) => {
      enter();
      await new Promise(r => { if (signal.aborted) r(); else signal.addEventListener('abort', r, { once: true }); });
      return { exitCode: null, output: '', failure: 'Cancellation was requested but the process did not close within 5000 ms; descendant processes may still be running' };
    };
    await scheduler.fire(job); await started;
    scheduler.stop(); const drain = await scheduler.drain(5000);
    results.samples.push({ id: 'G5-003', iteration, seam: 'runCommand boundary outcome substitution; no OS child/pipe, does not test close-wait timer', drain, cleanupDiagnosticEmitted: JSON.stringify({ sent, emitted, drain }).includes('did not close'), nativeFailureReproduced: false, classification: 'partial observation only; not counted as confirmed product defect' });
    console.log(`Progress: G5-005 bounded logger IO barrier ${iteration}/3`);
    let release, entered, pendingAppend;
    const gate = new Promise(r => release = r), appendEntered = new Promise(r => entered = r);
    fs.appendFile = (...args) => { entered(); pendingAppend = gate.then(() => originalAppend(...args)); return pendingAppend; };
    syncBuiltinESMExports();
    logger.debugLog('review-first-batch', { iteration }, true); tick(); await appendEntered;
    for (let n = 0; n < 16; n++) logger.debugLog('review-buffered', { iteration, n, text: 'x'.repeat(16 * 1024) }, true);
    logger.flushDebugLog();
    release(); await pendingAppend; await new Promise(r => setImmediate(r));
    fs.appendFile = originalAppend; syncBuiltinESMExports(); logger.flushDebugLog();
    const path = join(process.env.PI_CODING_AGENT_DIR, 'pi-blackhole/debug.ndjson');
    const content = await fs.readFile(path, 'utf8');
    const entries = content.trim().split('\n').map(row => JSON.parse(row)).filter(row => row.data.iteration === iteration);
    assert.equal(entries.length, 17);
    results.samples.push({ id: 'G5-005', iteration, seam: 'direct logger API, async append barrier, bounded 16x16KiB events; not actual OM event-rate pipeline', preservedEvents: entries.length, bufferedPayloadBytes: 16 * 16 * 1024, finalLogBytes: Buffer.byteLength(content), hardLimitFailureObserved: false, classification: 'capacity risk remains unverified; bounded sample does not prove unbounded exhaustion' });
  }
} finally {
  fs.appendFile = originalAppend; syncBuiltinESMExports(); globalThis.setInterval = originalSetInterval;
  await fs.rm(home, { recursive: true, force: true }); results.cleanup = true;
  await fs.writeFile(join(out, 'limited-results.json'), JSON.stringify(results, null, 2));
}
console.log(`Progress: limited probes complete, ${results.samples.length} samples; do not interpret as native lifecycle proof`);
