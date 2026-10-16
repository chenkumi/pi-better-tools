import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeDebugEnabled, runtimeLogSnapshot, writeRuntimeFailure } from '../src/debug-log.js';

function isolated() {
  const agentDir = mkdtempSync(join(tmpdir(), 'runtime-debug-'));
  return { agentDir, logsDir: join(agentDir, 'logs'), now: new Date('2026-10-14T05:00:00Z'),
    settings: join(agentDir, 'settings.json'), cleanup: () => rmSync(agentDir, { recursive: true, force: true }) };
}

test('logging is global-only boolean opt-in, tolerates BOM and rereads configuration', () => {
  const f = isolated();
  try {
    for (const settings of [undefined, 'broken JSON', '[]', '{}', '{"pi-runtime":[]}',
      '{"pi-runtime":{"debugLog":"true"}}', '{"pi-runtime":{"debugLog":false}}']) {
      if (settings !== undefined) writeFileSync(f.settings, settings);
      assert.equal(runtimeDebugEnabled(f), false);
      writeRuntimeFailure({ event: 'api_error' }, f); assert.equal(existsSync(f.logsDir), false);
    }
    writeFileSync(f.settings, '\uFEFF{"pi-runtime":{"debugLog":true}}');
    assert.equal(runtimeDebugEnabled(f), true); writeRuntimeFailure({ event: 'api_error' }, f);
    const path = join(f.logsDir, '2026-10-14.jsonl');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).value.event, 'api_error');
    writeFileSync(f.settings, '{"pi-runtime":{"debugLog":false}}');
    writeRuntimeFailure({ event: 'must-not-append' }, f);
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
  } finally { f.cleanup(); }
});

test('daily JSONL preserves reasons and valid-length parameters, masks common secrets, and reports truncation', () => {
  const f = isolated();
  try {
    writeFileSync(f.settings, '{"pi-runtime":{"debugLog":true}}');
    const args = 'owned local read-only scope ' + 'x'.repeat(4000);
    writeRuntimeFailure({ event: 'manual_recovery_rejected', reason: 'not_eligible', args, trimmedLength: args.length,
      authorization: 'AUTH_SECRET', nested: { api_key: 'KEY_SECRET', password: 'PASS_SECRET' },
      error: 'api_key="PREFIX\\"KEY_SUFFIX" password="PASS_SUFFIX" Bearer BEARER_SECRET https://user:URL_SECRET@host/path?signature=SIG_SECRET' }, f);
    writeRuntimeFailure({ event: 'api_error', request: { input: 'x'.repeat(10000) } }, f);
    const path = join(f.logsDir, '2026-10-14.jsonl');
    const raw = readFileSync(path, 'utf8'); const lines = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 2); assert.equal(lines[0].version, 1);
    assert.equal(lines[0].value.args, args); assert.equal(lines[0].value.reason, 'not_eligible');
    assert.doesNotMatch(raw, /AUTH_SECRET|KEY_SECRET|PASS_SECRET|KEY_SUFFIX|PASS_SUFFIX|BEARER_SECRET|URL_SECRET|SIG_SECRET/);
    assert.equal(lines[0].truncated, false); assert.equal(lines[1].truncated, true);
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(f.logsDir).mode & 0o777, 0o700);
    }
  } finally { f.cleanup(); }
});

test('snapshots bound cycles, deep/broad payloads, omit media, and never mutate input', () => {
  const data: any = { authorization: 'PRIVATE', image_url: 'data:PRIVATE_IMAGE', input: ['owned task'] };
  data.cycle = data;
  const snapshot = runtimeLogSnapshot(data);
  assert.equal(data.authorization, 'PRIVATE'); assert.equal(data.input[0], 'owned task');
  assert.equal(snapshot.truncated, true); assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
  const broad = runtimeLogSnapshot(Array.from({ length: 200 }, () => 'x'.repeat(8192)));
  assert.equal(broad.truncated, true); assert.ok(JSON.stringify(broad).length < 60000);
});

test('enabled log write failure is observable to Runtime rather than falsely acknowledged', () => {
  const f = isolated();
  try {
    writeFileSync(f.settings, '{"pi-runtime":{"debugLog":true}}');
    writeFileSync(f.logsDir, 'not a directory');
    assert.throws(() => writeRuntimeFailure({ event: 'api_error' }, f));
  } finally { f.cleanup(); }
});
