import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
import { runCommand } from '../../file-tools/scripts/test-process.mjs';

const fixture = fileURLToPath(new URL('./fixtures/recovery-host.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
for (const mode of ['quit', 'crash']) test(`Pi 1.0.0 recovery after ${mode}: two process journal load, no provider calls, reload/resume dedup`, { timeout: 120000 }, async () => {
  console.log(`[recovery] Checking isolated ${mode} and startup/resume notifications.`);
  const home = await mkdtemp(join(tmpdir(), 'pi-background-recovery-'));
  await mkdir(join(home, 'tmp'));
  const env = { ...isolatedEnv(home), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp') };
  let child;
  try {
    let sessionFile;
    if (mode === 'quit') {
      const output = await runCommand('recovery orderly quit', process.execPath, ['--import', tsx, fixture, mode], { cwd: home, env, timeoutMs: 90000 });
      const result = JSON.parse(output.trim().split('\n').at(-1)); assert.equal(result.providerCalls, 0); sessionFile = result.file;
    } else {
      child = spawn(process.execPath, ['--import', tsx, fixture, mode], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let diagnostics = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { diagnostics = (diagnostics + d).slice(-16000); });
      const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      const ready = new Promise((resolve, reject) => {
        child.once('message', m => { if (m.phase === 'ready') resolve(m); else reject(new Error('Unexpected fixture message')); });
        child.once('error', reject); child.once('exit', () => reject(new Error(`Fixture exited before crash barrier: ${diagnostics}`)));
      });
      sessionFile = (await ready).file;
      assert.equal(child.kill('SIGKILL'), true);
      const end = await closed; assert.ok(end.signal === 'SIGKILL' || end.code !== 0, 'forced termination bypasses orderly shutdown');
    }
    assert.equal(typeof sessionFile, 'string'); assert.ok(sessionFile.startsWith(home), 'only isolated fixture session may be opened');
    const output = await runCommand('recovery loaded session', process.execPath, ['--import', tsx, fixture, 'load', sessionFile], { cwd: home, env, timeoutMs: 90000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.status, 'passed'); assert.equal(result.providerCalls, 0); assert.equal(result.notices, 2); assert.equal(result.role, 'custom');
    assert.ok(result.starts.includes('startup')); assert.ok(result.starts.includes('reload')); assert.ok(result.starts.includes('resume'));
    assert.equal(result.findings.length, 2); assert.equal(result.compaction, true); assert.equal(result.persistedNotices, 4);
    if (mode === 'crash') assert.ok(result.findings.every(f => f.finding === 'outcome_unknown'));
    else { assert.ok(result.findings.every(f => f.finding === 'terminal_result_recorded' && f.reason === 'quit')); }
    console.log(`[recovery] ${mode} -> startup/reload/resume passed without provider calls.`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await closed;
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const mode of ['empty', 'no-session']) test(`Pi 1.0.0 rejects non-durable ${mode} background admission before allocation/spawn`, { timeout: 120000 }, async () => {
  console.log(`[recovery] Checking isolated ${mode} durable admission fence.`);
  const home = await mkdtemp(join(tmpdir(), 'pi-recovery-admission-'));
  await mkdir(join(home, 'tmp'));
  try {
    const output = await runCommand(`recovery ${mode}`, process.execPath, ['--import', tsx, fixture, mode], { cwd: home, env: { ...isolatedEnv(home), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp') }, timeoutMs: 90000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.status, 'passed'); assert.equal(result.providerCalls, 0); assert.equal(result.runs, 0); assert.equal(result.prepares, 0);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
