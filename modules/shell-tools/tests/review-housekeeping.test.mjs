import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { ShellJobs } from '../src/background-jobs.ts';

test('R19 receipt performs no synchronous tmpdir sweep or stale removal work', async (t) => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-review-housekeeping-'));
 const oldEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
 for (const key of Object.keys(oldEnv)) process.env[key] = root;
 const originalRead = fs.readdirSync.bind(fs), originalRm = fs.rmSync.bind(fs);
 let synchronousSweep = 0, synchronousRemoval = 0;
 for (let i = 0; i < 8; i++) {
  const dir = path.join(root, `pi-shell-job-stale-${i}`); fs.mkdirSync(dir);
  fs.utimesSync(dir, new Date(0), new Date(0));
 }
 t.mock.method(fs, 'readdirSync', (...args) => { if (String(args[0]) === root) synchronousSweep++; return originalRead(...args); });
 t.mock.method(fs, 'rmSync', (...args) => { if (String(args[0]).includes('pi-shell-job-stale-')) synchronousRemoval++; return originalRm(...args); });
 syncBuiltinESMExports();
 const jobs = new ShellJobs({ sendMessage() {} });
 const ctx = { cwd: root, sessionManager: { getSessionId: () => 'owner' }, hasUI: false };
 jobs.start(ctx);
 try {
  const receipt = jobs.submit(ctx, 'bash', 'review', undefined, async () => ({ content: [], details: undefined }));
  assert.equal(receipt.status, 'running'); assert.ok(fs.existsSync(receipt.liveLogPath));
  assert.equal(synchronousSweep, 0, 'receipt synchronously enumerated the isolated tmp root');
  assert.equal(synchronousRemoval, 0, 'receipt synchronously removed stale directories');
 } finally {
  await jobs.shutdown(); t.mock.restoreAll(); syncBuiltinESMExports();
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  originalRm(root, { recursive: true, force: true });
 }
});
