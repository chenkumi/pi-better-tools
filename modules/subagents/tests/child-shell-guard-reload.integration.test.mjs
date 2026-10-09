import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

for (const mode of ['stable', 'config', 'trust', 'foreign', 'new-invocation', 'tampered', 'same-size-tampered', 'replacement', 'missing']) {
  test(`real Pi 1.1.0 guard + foreground Shell same-process reload: ${mode}`, { timeout: 60000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'child-shell-review-guard-'));
    try {
      const fixture = fileURLToPath(new URL('./fixtures/child-shell-guard-reload-host.mjs', import.meta.url));
      const proc = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fixture, mode], { env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, timeout: 45000, killSignal: 'SIGKILL' });
      let stdout = '', stderr = ''; const observations = [];
      proc.stdout.on('data', bytes => stdout += bytes); proc.stderr.on('data', bytes => stderr += bytes);
      proc.on('message', message => { if (message.channel === 'pi-subagent-startup') observations.push(message); });
      const exitCode = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
      const tracePath = path.join(home, 'trace.jsonl');
      const records = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').map(JSON.parse) : [];
      console.log(JSON.stringify({ mode, exitCode, extensionErrors: records.filter(x => x.phase === 'extension_error'), phases: observations.map(x => [x.phase, x.errorCode]), admissions: records.filter(x => x.phase === 'provider_admitted').length }));
      const receipt = path.join(home, 'startup.json');
      if (mode === 'stable') {
        assert.equal(exitCode, 0, stderr + stdout);
        assert.deepEqual(records.filter(x => x.phase === 'extension_error'), [], 'reload must not swallow EEXIST');
        assert.equal(observations.filter(x => x.phase === 'guard_verified').length, 3);
        const first = records.find(x => x.phase === 'first_bound'), reload = records.find(x => x.phase === 'reload_finished');
        assert.equal(first.pid, reload.pid); assert.equal(reload.receipt, first.receipt);
        assert.deepEqual(reload.fingerprint, first.fingerprint, 'reload is read-only: receipt identity/mtime unchanged');
        assert.deepEqual(records.find(x => x.phase === 'second_reload_finished').fingerprint, first.fingerprint);
        assert.ok(!('background' in reload.schema.properties)); assert.equal(reload.managementPresent, false);
        assert.equal(records.filter(x => x.phase === 'provider_admitted').length, 1, 'offline positive admission control');
      } else {
        assert.equal(exitCode, 1, stderr + stdout);
        assert.equal(records.filter(x => x.phase === 'provider_admitted').length, 0, 'no provider admission after rejection/ownership failure');
        if (mode === 'config' || mode === 'trust') {
          const code = mode === 'config' ? 'CONFIG_CHANGED' : 'TRUST_REQUIRED';
          assert.ok(observations.some(x => x.phase === 'guard_rejected' && x.errorCode === code), JSON.stringify(observations));
          assert.doesNotMatch(stderr, /EEXIST/);
          assert.equal(fs.readFileSync(receipt, 'utf8'), records.find(x => x.phase === 'first_bound').receipt, 'rejection never rewrites the original receipt');
        }
        if (mode === 'foreign') assert.equal(fs.readFileSync(receipt, 'utf8'), 'FOREIGN_RECEIPT');
        if (mode === 'tampered') assert.equal(fs.readFileSync(receipt, 'utf8'), 'TAMPERED_RECEIPT');
        if (mode === 'same-size-tampered') assert.equal(fs.readFileSync(receipt, 'utf8'), 'x' + records.find(x => x.phase === 'first_bound').receipt.slice(1));
        if (mode === 'missing') assert.equal(fs.existsSync(receipt), false);
        if (mode === 'replacement' || mode === 'new-invocation') assert.equal(fs.readFileSync(receipt, 'utf8'), records.find(x => x.phase === 'first_bound').receipt);
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}
