import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CredentialStore } from '../src/credentials.js';
import { normalizeCode } from '../src/protocol.js';

function store(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-remote-credentials-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'pi-remote.json');
  return { path, dir, make: () => new CredentialStore(path) };
}

test('the server code is created once, survives a new store instance, and regenerating replaces it', async t => {
  const { make } = store(t);
  const first = await make().serverCode();
  assert.ok(normalizeCode(first));
  assert.equal(await make().serverCode(), first);
  const next = await make().regenerateServerCode();
  assert.notEqual(next, first);
  assert.equal(await make().serverCode(), next);
});

test('client codes are kept per host:port, normalized, and independent of the server code', async t => {
  const { make } = store(t);
  const credentials = make();
  assert.equal(await credentials.clientCode('10.0.0.1:7821'), undefined);
  await credentials.saveClientCode('10.0.0.1:7821', 'abcd efgh jklm');
  assert.equal(await credentials.clientCode('10.0.0.1:7821'), 'ABCDEFGHJKLM');
  assert.equal(await credentials.clientCode('10.0.0.2:7821'), undefined);
  await credentials.serverCode();
  assert.equal(await credentials.clientCode('10.0.0.1:7821'), 'ABCDEFGHJKLM', 'creating the server code keeps client codes');
  await assert.rejects(credentials.saveClientCode('10.0.0.1:7821', 'too short'), /12 letters and digits/);
});

test('a damaged credentials file is reported and left untouched, never overwritten', async t => {
  const { make, path } = store(t);
  await make().serverCode();
  writeFileSync(path, '{ damaged');
  await assert.rejects(make().serverCode(), /not valid JSON/);
  await assert.rejects(make().saveClientCode('h:1', 'ABCD-EFGH-JKLM'), /not valid JSON/);
  assert.equal(readFileSync(path, 'utf8'), '{ damaged');
});
