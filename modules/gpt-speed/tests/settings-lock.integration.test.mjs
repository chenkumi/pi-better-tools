// D22: gpt-speed locks realpath(settings.json) while Pi's FileSettingsStorage locks the lexical <agentDir>/settings.json.
// With a symlinked settings.json the two lock paths differ, so the writers are not mutually exclusive.
// Levels:
//   1. real file symlink (needs OS privilege; on Windows without Developer Mode it is skipped, NOT counted as passing)
//   2. junction alias of agentDir (control: both lock paths are physically the same directory entry, expected green)
//   3. degraded simulation: real modules + real locks, only fs.realpathSync is mocked to behave like the symlink (child process)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describeFailure, probe } from '../../../tests/helpers/regression/d22-probe.mjs';
import { root } from '../../../tests/helpers/regression/run-cli.mjs';

const exec = promisify(execFile);
const mkTemp = () => mkdtemp(join(tmpdir(), 'repro-d22-'));
const rmTree = dir => rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });

test('D22 level 1: real file symlink settings.json -> other dir; writers must be mutually exclusive', { timeout: 120000 }, async t => {
  const dir = await mkTemp();
  try {
    const agentDir = join(dir, 'agent'), other = join(dir, 'elsewhere'), cwd = join(dir, 'ws');
    await Promise.all([mkdir(agentDir), mkdir(other), mkdir(cwd)]);
    await writeFile(join(other, 'settings.json'), '{}');
    try { await symlink(join(other, 'settings.json'), join(agentDir, 'settings.json'), 'file'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip(`cannot create file symlink without privilege (${error.code}); level 1 NOT verified`); throw error; }
    console.error('[repro:D22-symlink] probing with a real symlink...');
    const result = await probe({ root, hostAgentDir: agentDir, moduleSettingsReadPath: join(agentDir, 'settings.json'), cwd });
    assert.equal(result.modeWrittenWhileHostLocked, false, `writers overlapped: ${describeFailure(result)}`);
  } finally { await rmTree(dir); }
});

test('D22 level 2 (control): junction alias agentDir shares one physical lock dir, expected green', { timeout: 120000 }, async () => {
  const dir = await mkTemp();
  try {
    const real = join(dir, 'real-agent'), alias = join(dir, 'alias-agent'), cwd = join(dir, 'ws');
    await Promise.all([mkdir(real), mkdir(cwd)]);
    await writeFile(join(real, 'settings.json'), '{}');
    await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await probe({ root, hostAgentDir: alias, moduleSettingsReadPath: join(real, 'settings.json'), cwd });
    assert.equal(result.modeWrittenWhileHostLocked, false, `writers overlapped: ${describeFailure(result)}`);
  } finally { await rmTree(dir); }
});

test('D22 level 3 (degraded simulation of the symlink via realpathSync mock): writers must be mutually exclusive', { timeout: 120000 }, async () => {
  const dir = await mkTemp();
  try {
    console.error('[repro:D22-simulated] running child with mocked realpathSync...');
    const { stdout } = await exec(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./settings-lock-simulated-child.mjs', import.meta.url)), root, dir], { cwd: dir, env: { ...process.env, PI_OFFLINE: '1' }, timeout: 100000 });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.modeWrittenWhileHostLocked, false, `writers overlapped: ${describeFailure(result)}`);
  } finally { await rmTree(dir); }
});
