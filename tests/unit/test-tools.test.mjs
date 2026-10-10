import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRipgrep, provisionRipgrep } from '../helpers/test-tools.mjs';

const probe = () => ({ status: 0, stdout: 'ripgrep 15.2.0\nfeatures:test' });
test('resolves the actual PATH binary; Windows casing is deterministic', () => {
  const result = resolveRipgrep({ platform: 'win32', env: { Path: 'C:\\wrong', PATH: '"C:\\tools";C:\\later' }, exists: p => p === 'C:\\tools\\rg.exe', canonicalize: p => p, probe });
  assert.equal(result.path, 'C:\\tools\\rg.exe');
  assert.equal(result.version, 'ripgrep 15.2.0');
});
test('explicit binary must work; never falls back to PATH for a bad override', () => {
  assert.throws(() => resolveRipgrep({ binary: '/bad/rg', platform: 'linux', exists: () => true, canonicalize: p => p, probe: () => ({ status: 1, stdout: 'ripgrep fake' }) }), /TEST_RG_UNAVAILABLE/);
  assert.throws(() => resolveRipgrep({ binary: '/bad/rg', platform: 'linux', exists: () => true, canonicalize: p => p, probe: () => ({ status: 0, stdout: 'not ripgrep' }) }), /TEST_RG_UNAVAILABLE/);
});
test('missing rg is an explicit prerequisite failure, not skip or download', () => {
  assert.throws(() => resolveRipgrep({ env: { PATH: '' }, exists: () => false }), /TEST_RG_UNAVAILABLE.*PI_BETTER_TOOLS_TEST_RG/);
});
test('POSIX lookup follows a symlink to its binary and ignores empty PATH entries', () => {
  const result = resolveRipgrep({ platform: 'linux', env: { PATH: ':/tools:/later' }, exists: p => p === '/tools/rg', canonicalize: () => '/actual/rg', probe });
  assert.equal(result.path, '/actual/rg');
});
test('copies only the binary into isolated agentDir/bin and preserves source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'test-rg-unit-'));
  try {
    const source = join(root, 'source'); await writeFile(source, 'test binary bytes', { mode: 0o700 });
    const home = join(root, 'home');
    const result = await provisionRipgrep(home, { source: { path: source, version: 'ripgrep fixture' } });
    assert.equal(result.path, join(home, '.pi', 'agent', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'));
    assert.equal(await readFile(result.path, 'utf8'), 'test binary bytes');
    assert.equal(await readFile(source, 'utf8'), 'test binary bytes');
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') assert.equal((await stat(result.path)).mode & 0o777, 0o700);
    await assert.rejects(provisionRipgrep(home, { source: { path: source, version: 'ripgrep fixture' } }), { code: 'EEXIST' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
