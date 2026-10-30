import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { isLoopback, loadRemoteConfig, parseRemoteConfig, remoteConfigPath } from '../src/config.js';

const server = { mode: 'server', server: { port: 7821 } };
const client = { mode: 'client', client: { host: '192.168.1.10', port: 7821 } };
const message = (raw: unknown) => { try { parseRemoteConfig(raw); } catch (error) { return (error as Error).message; } return ''; };

test('server and client defaults: wake on, loopback bind, wss for clients', () => {
  assert.deepEqual(parseRemoteConfig(server), { mode: 'server', wake: 'on', allowFrom: [], insecure: false, server: { port: 7821, bind: '127.0.0.1' } });
  assert.deepEqual(parseRemoteConfig({ ...client, name: 'Mac-Test', wake: 'allowlist', allowFrom: ['Win-Dev'] }), {
    mode: 'client', name: 'mac-test', wake: 'allowlist', allowFrom: ['win-dev'], insecure: false, client: { host: '192.168.1.10', port: 7821, tls: true },
  });
  assert.equal(parseRemoteConfig({ mode: 'off' }), undefined);
});

test('unknown keys are rejected so a typo cannot silently run with defaults', () => {
  assert.match(message({ ...server, tokenEnv: 'X' }), /unknown key "tokenEnv"/);
  assert.match(message({ mode: 'server', server: { port: 1, prot: 2 } }), /server: unknown key "prot"/);
  assert.match(message({ ...client, client: { host: 'h', port: 1, secure: true } }), /client: unknown key "secure"/);
});

test('mode, name, wake, port and role sections are validated', () => {
  assert.match(message({}), /mode/);
  assert.match(message({ mode: 'peer' }), /mode/);
  assert.match(message({ ...server, name: 'Not A Name' }), /name:/);
  assert.match(message({ ...server, wake: 'sometimes' }), /wake:/);
  assert.match(message({ ...server, allowFrom: ['ok', 'bad name'] }), /allowFrom/);
  assert.match(message({ mode: 'server' }), /server: required/);
  assert.match(message({ mode: 'server', server: {} }), /server\.port/);
  assert.match(message({ mode: 'server', server: { port: 70000 } }), /server\.port/);
  assert.match(message({ mode: 'server', server: { port: '80' } }), /server\.port/);
  assert.match(message({ ...server, client: { host: 'h', port: 1 } }), /client: not used/);
  assert.match(message({ mode: 'client' }), /client: required/);
  assert.match(message({ mode: 'client', client: { host: 'ws://h', port: 1 } }), /bare host/);
  assert.match(message({ ...client, server: { port: 1 } }), /server: not used/);
});

test('plain ws beyond loopback needs an explicit opt-in on both sides; wss does not', () => {
  assert.match(message({ mode: 'server', server: { port: 1, bind: '0.0.0.0' } }), /tls.*insecure/);
  assert.equal(message({ mode: 'server', server: { port: 1, bind: '0.0.0.0', tls: { cert: 'c.pem', key: 'k.pem' } } }), '');
  assert.equal(message({ mode: 'server', insecure: true, server: { port: 1, bind: '0.0.0.0' } }), '');
  assert.match(message({ mode: 'client', client: { host: '10.0.0.5', port: 1, tls: false } }), /insecure/);
  assert.equal(message({ mode: 'client', client: { host: '127.0.0.1', port: 1, tls: false } }), '');
  assert.equal(message({ mode: 'client', insecure: true, client: { host: '10.0.0.5', port: 1, tls: false } }), '');
  assert.match(message({ mode: 'server', server: { port: 1, tls: { cert: 'c.pem' } } }), /server\.tls\.key/);
  for (const host of ['127.0.0.1', '127.9.9.9', 'localhost', '::1', '[::1]']) assert.equal(isLoopback(host), true, host);
  for (const host of ['0.0.0.0', '192.168.1.2', 'example.com', '::']) assert.equal(isLoopback(host), false, host);
});

function project(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-remote-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (contents: string) => { mkdirSync(dirname(remoteConfigPath(dir)), { recursive: true }); writeFileSync(remoteConfigPath(dir), contents); };
  return { dir, write };
}

test('loading: missing file or untrusted project means off, and an untrusted file is not even read', async t => {
  const { dir, write } = project(t);
  assert.deepEqual(await loadRemoteConfig(dir, true), { kind: 'off' });
  write('{ not json');
  assert.deepEqual(await loadRemoteConfig(dir, false), { kind: 'off' });
});

test('loading: a valid file (with BOM) loads; bad JSON and bad values are reported with the path, never as off', async t => {
  const { dir, write } = project(t);
  write(`﻿${JSON.stringify(server)}`);
  const ok = await loadRemoteConfig(dir, true);
  assert.equal(ok.kind, 'ok');
  write('{ not json');
  const broken = await loadRemoteConfig(dir, true);
  assert.equal(broken.kind, 'error');
  assert.match(broken.kind === 'error' ? broken.message : '', /remote\.json.*not valid JSON/);
  write(JSON.stringify({ mode: 'server', server: { port: 0 } }));
  const invalid = await loadRemoteConfig(dir, true);
  assert.match(invalid.kind === 'error' ? invalid.message : '', /server\.port/);
  write(JSON.stringify({ mode: 'off' }));
  assert.deepEqual(await loadRemoteConfig(dir, true), { kind: 'off' });
});
