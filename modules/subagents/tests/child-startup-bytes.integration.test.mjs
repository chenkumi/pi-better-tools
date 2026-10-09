import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

for (const mode of ['unicode-stable', 'replacement-character-stable', 'invalid-utf8']) {
  test(`real Pi 1.1.0 byte-exact receipt reload: ${mode}`, { timeout: 60000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'child-shell-bytes-host-'));
    try {
      const fixture = fileURLToPath(new URL('./fixtures/child-shell-guard-reload-host.mjs', import.meta.url));
      const proc = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fixture, mode], {
        env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, timeout: 45000, killSignal: 'SIGKILL',
      });
      let stdout = '', stderr = ''; const observations = [];
      proc.stdout.on('data', bytes => stdout += bytes); proc.stderr.on('data', bytes => stderr += bytes);
      proc.on('message', message => { if (message.channel === 'pi-subagent-startup') observations.push(message); });
      const exitCode = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
      const records = fs.readFileSync(path.join(home, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const errors = records.filter(x => x.phase === 'extension_error'), admissions = records.filter(x => x.phase === 'provider_admitted').length;
      console.log(JSON.stringify({ mode, exitCode, admissions, extensionErrors: errors, phases: observations.map(x => [x.phase, x.errorCode]) }));
      assert.deepEqual(errors, []);
      if (mode === 'invalid-utf8') {
        const mutation = records.find(x => x.phase === 'invalid_utf8_mutation');
        const original = Buffer.from(mutation.original, 'base64'), tampered = Buffer.from(mutation.tampered, 'base64');
        assert.equal(mutation.before.dev, mutation.after.dev); assert.equal(mutation.before.ino, mutation.after.ino);
        assert.equal(original.length, tampered.length); assert.ok(!original.equals(tampered));
        assert.equal(original.toString('utf8'), tampered.toString('utf8'));
        assert.equal(exitCode, 1, stdout + stderr); assert.equal(admissions, 0);
        assert.ok(observations.some(x => x.phase === 'guard_failed'));
        assert.ok(fs.readFileSync(path.join(home, 'startup.json')).equals(tampered), 'terminal rejection preserves raw invalid UTF-8');
      } else {
        assert.equal(exitCode, 0, stdout + stderr); assert.equal(admissions, 1);
        assert.equal(observations.filter(x => x.phase === 'guard_verified').length, 3);
        const first = records.find(x => x.phase === 'first_bound'), reload = records.find(x => x.phase === 'reload_finished');
        assert.equal(first.pid, reload.pid); assert.deepEqual(reload.fingerprint, first.fingerprint);
        assert.ok(fs.readFileSync(path.join(home, 'startup.json')).equals(Buffer.from(first.receipt, 'utf8')));
        assert.ok(!('background' in reload.schema.properties)); assert.equal(reload.managementPresent, false);
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}
