import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../modules/file-tools/scripts/test-process.mjs';
import { isolatedEnv } from '../helpers/environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'ms-playwright') : process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright'));
for (const mode of ['missing', 'real']) {
  test(`Web browser/File read component composition: ${mode}`, { timeout: 120000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-better-tools-browser-'));
    try {
      const output = await runCommand(`browser ${mode}`, process.execPath, ['--import', import.meta.resolve('tsx'), join(root, 'tests/fixtures/browser.mjs'), root, mode],
        { cwd: home, env: { ...isolatedEnv(home), PLAYWRIGHT_BROWSERS_PATH: mode === 'missing' ? join(home, 'no-installed-browser') : cache }, timeoutMs: 100000 });
      assert.match(output, mode === 'missing' ? /"missingBrowserError":true/ : /"paginatedRead":true.*"browserClosed":true/);
    } finally { await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
  });
}
