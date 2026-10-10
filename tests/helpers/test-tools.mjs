import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { createHash } from 'node:crypto';

// Test infrastructure only. Never download tools, inherit credentials, or modify
// the source binary/user settings. CI must install rg or supply an explicit path.
export function resolveRipgrep({ env = process.env, platform = process.platform,
  binary = env.PI_BETTER_TOOLS_TEST_RG, exists = existsSync,
  canonicalize = realpathSync, probe = spawnSync } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const pathKey = platform === 'win32' ? Object.keys(env).sort().find(k => k.toLowerCase() === 'path') : 'PATH';
  const candidates = binary ? [paths.resolve(binary)] : (env[pathKey] ?? '').split(paths.delimiter)
    .map(p => p.replace(/^"|"$/g, '')).filter(Boolean)
    .map(p => paths.resolve(p, platform === 'win32' ? 'rg.exe' : 'rg'));
  for (const candidate of candidates) {
    try {
      if (!exists(candidate)) continue;
      const path = canonicalize(candidate);
      const probeEnv = Object.fromEntries(Object.entries(env).filter(([key]) => ['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp'].includes(key.toLowerCase())));
      const result = probe(path, ['--version'], { env: probeEnv, encoding: 'utf8', timeout: 10000, windowsHide: true });
      const version = result.stdout?.trim().split(/\r?\n/)[0];
      if (!result.error && result.status === 0 && /^ripgrep\s/.test(version ?? '')) return { path, version };
    } catch { /* An invalid explicit override must not silently use PATH. */ }
  }
  throw new Error('TEST_RG_UNAVAILABLE: install ripgrep on PATH or set PI_BETTER_TOOLS_TEST_RG to a working binary');
}

export async function provisionRipgrep(home, { source = resolveRipgrep() } = {}) {
  const bin = join(home, '.pi', 'agent', 'bin');
  const path = join(bin, process.platform === 'win32' ? 'rg.exe' : 'rg');
  await mkdir(bin, { recursive: true });
  await copyFile(source.path, path, constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') await chmod(path, (await stat(source.path)).mode & 0o777);
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
  console.log(`[test-tools] Isolated rg: ${source.version}; source=${source.path}; sha256=${sha256}`);
  return { path, version: source.version, sha256 };
}
