import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createPiFixture } from './helpers/pi-fixture.mjs';

test('foreground-only rejection preserves opt-in diagnostics in isolated home before execution settings/backend/spawn', { timeout: 60000 }, async () => {
  const savedEnv = process.env.PI_SUBAGENTS_GUARD, saved = globalThis.__piSubagentsGuardExpected;
  const fixture = await createPiFixture();
  try {
    delete globalThis.__piSubagentsGuardExpected;
    process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ id: 'fixture', cwd: '/fixture', startupPath: '/fixture/startup', shellMode: 'foreground-v1' });
    fixture.writeDebugSettings({ 'pi-shell-tools': { debugLog: true } });
    const { session, cwd } = await fixture.createSession({ defaultTools: ['bash'], settings: { shellPath: path.join(fixture.temp, 'MISSING_SHELL_MUST_NOT_BE_RESOLVED') } });
    const input = { command: 'printf forbidden > must-not-exist', background: false };
    await assert.rejects(fixture.execute(session, 'bash', input), /foreground-only/);
    assert.equal(fs.existsSync(path.join(cwd, 'must-not-exist')), false);
    const logs = path.join(fixture.homeDir, '.pi', 'logs', 'pi-shell-tools');
    const files = fs.readdirSync(logs); assert.equal(files.length, 1);
    const record = JSON.parse(fs.readFileSync(path.join(logs, files[0]), 'utf8'));
    assert.deepEqual(record.input, input);
    assert.equal(record.failure.kind, 'exception');
    assert.match(record.failure.error.message, /foreground-only/);
    assert.equal(record.cwd, cwd);
  } finally {
    try { fixture.cleanup(); } finally {
      if (savedEnv === undefined) delete process.env.PI_SUBAGENTS_GUARD; else process.env.PI_SUBAGENTS_GUARD = savedEnv;
      if (saved === undefined) delete globalThis.__piSubagentsGuardExpected; else globalThis.__piSubagentsGuardExpected = saved;
    }
  }
});
