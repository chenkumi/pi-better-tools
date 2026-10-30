import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { readRaw, saveSettings, type Values } from '../../pi-runtime/src/settings-panel/index.js';
import { loadRemoteConfig, remoteConfigPath } from '../src/config.js';
import { CredentialStore } from '../src/credentials.js';
import { generateCode, normalizeCode } from '../src/protocol.js';
import { parsePanelConfig, registerRemoteSettings, remoteSettings, type PanelConfig } from '../src/settings.js';

function project(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-remote-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = remoteConfigPath(dir);
  const credentialsPath = join(dir, 'home', 'pi-remote.json');
  const credentials = new CredentialStore(credentialsPath);
  const write = (value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  const read = () => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  /** What the panel does on Save: initial values from the file, the user's edits on top, then the shared save. */
  let shown = '';
  const save = async (edits: Partial<Record<keyof PanelConfig | 'serverCode' | 'clientCode', string | number | boolean>>) => {
    // Opening the panel: the stored code, or a fresh candidate that counts as changed (the real panel does the same via `unsaved`).
    const stored = await credentials.peekServerCode().catch(() => undefined); // like the command: an unreadable store keeps the candidate
    const schema = remoteSettings(path, credentials, { serverCode: stored ?? generateCode(), serverCodeStored: Boolean(stored), clientCodeSet: false });
    const state = readRaw(path);
    const values: Values = { ...schema.toValues(schema.parse(state.state === 'ok' ? state.raw : {})), ...edits as Values };
    shown = String(values.serverCode);
    const dirty = new Set(Object.keys(edits));
    if (values.mode === 'server') for (const key of schema.unsaved ?? []) dirty.add(key); // only visible fields count
    return saveSettings(schema, values, dirty);
  };
  return { dir, path, credentials, credentialsPath, write, read, save, shown: () => shown };
}

test('the panel view of a file follows the loader: defaults when absent, parsed values when valid, loader errors when not', () => {
  assert.deepEqual(parsePanelConfig({}), { mode: 'off', name: '', wake: 'on', allowFrom: '', insecure: false, serverPort: 7821, bind: '127.0.0.1', tlsCert: '', tlsKey: '', host: '', clientPort: 7821, clientTls: true });
  assert.equal(parsePanelConfig({ mode: 'server', name: 'srv', wake: 'allowlist', allowFrom: ['a', 'b'], server: { port: 9000, bind: '0.0.0.0', tls: { cert: 'c.pem', key: 'k.pem' } } }).allowFrom, 'a, b');
  assert.equal(parsePanelConfig({ mode: 'client', client: { host: '127.0.0.1', port: 1, tls: false } }).clientTls, false);
  assert.throws(() => parsePanelConfig({ mode: 'server', server: { port: 1 }, tokenEnv: 'x' }), /CONFIG_INVALID.*tokenEnv/);
  assert.equal(parsePanelConfig({ mode: 'off', name: 'kept', server: { port: 9000 } }).serverPort, 9000, 'an off file still shows what it holds');
});

test('turning a server on writes a file the loader accepts and creates the pairing code', async t => {
  const p = project(t);
  assert.equal(await p.save({ mode: 'server' }), undefined);
  assert.deepEqual(p.read(), { mode: 'server', server: { port: 7821 } });
  assert.equal((await loadRemoteConfig(p.dir, true)).kind, 'ok');
  assert.equal(await p.credentials.peekServerCode(), p.shown(), 'the code the panel showed is the code that is now in force');
  assert.ok(normalizeCode(p.shown()));
});

test('server options: LAN bind needs TLS or the insecure opt-in, and both TLS paths are required together', async t => {
  const p = project(t);
  assert.match((await p.save({ mode: 'server', bind: '0.0.0.0' })) ?? '', /CONFIG_INVALID.*tls.*insecure/);
  assert.equal(existsSync(p.path), false, 'a rejected save writes nothing');
  assert.match((await p.save({ mode: 'server', bind: '0.0.0.0', tlsCert: 'certs/cert.pem' })) ?? '', /^Enter both the certificate and the private key path/);
  assert.equal(await p.save({ mode: 'server', serverPort: 9000, bind: '0.0.0.0', tlsCert: ' certs/cert.pem ', tlsKey: 'certs/key.pem' }), undefined);
  assert.deepEqual(p.read(), { mode: 'server', server: { port: 9000, bind: '0.0.0.0', tls: { cert: 'certs/cert.pem', key: 'certs/key.pem' } } });
  assert.equal(await p.save({ tlsCert: '', tlsKey: '', insecure: true }), undefined);
  assert.deepEqual(p.read(), { mode: 'server', insecure: true, server: { port: 9000, bind: '0.0.0.0' } });
});

test('a fresh code is stored by Save, kept by later saves, and replaced only when the user regenerates it', async t => {
  const p = project(t);
  assert.equal(await p.credentials.peekServerCode(), undefined);
  await p.save({ mode: 'server' });
  const first = (await p.credentials.peekServerCode())!;
  assert.equal(first, p.shown());
  await p.save({ serverPort: 7822 });
  assert.equal(await p.credentials.peekServerCode(), first, 'the stored code is what the panel shows, so nothing changes');
  assert.equal(p.shown(), first);
  await p.save({ serverCode: generateCode() }); // Enter on the field, then Ctrl+S
  const second = (await p.credentials.peekServerCode())!;
  assert.notEqual(second, first);
  assert.equal(p.read().serverCode, undefined, 'the code is never a file key');
  assert.doesNotMatch(readFileSync(p.path, 'utf8'), /[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
});

test('a candidate code that was never saved is not stored: closing the panel leaves nothing behind', async t => {
  const p = project(t);
  assert.equal(await p.save({ mode: 'client', host: '' }) !== undefined, true); // refused
  assert.equal(await p.credentials.peekServerCode(), undefined);
});

test('a client stores the typed pairing code in the credentials store, never in the project file', async t => {
  const p = project(t);
  assert.match((await p.save({ mode: 'client' })) ?? '', /^Enter the server host/);
  assert.match((await p.save({ mode: 'client', host: '192.168.1.10', clientCode: 'too short' })) ?? '', /^Enter a 12-character pairing code/);
  assert.equal(existsSync(p.path), false);
  assert.equal(await p.save({ mode: 'client', host: ' 192.168.1.10 ', clientPort: 7822, clientCode: 'abcd efgh jklm' }), undefined);
  assert.deepEqual(p.read(), { mode: 'client', client: { host: '192.168.1.10', port: 7822 } });
  assert.doesNotMatch(readFileSync(p.path, 'utf8'), /ABCD|abcd/i);
  assert.equal(await p.credentials.clientCode('192.168.1.10:7822'), 'ABCDEFGHJKLM');
  assert.equal((await loadRemoteConfig(p.dir, true)).kind, 'ok');
});

test('editing only the pairing code leaves the project file untouched', async t => {
  const p = project(t);
  p.write({ mode: 'client', client: { host: 'h', port: 7821 } });
  const before = readFileSync(p.path, 'utf8');
  assert.equal(await p.save({ clientCode: 'ABCD-EFGH-JKLM' }), undefined);
  assert.equal(readFileSync(p.path, 'utf8'), before);
  assert.equal(await p.credentials.clientCode('h:7821'), 'ABCDEFGHJKLM');
});

test('switching role removes the other role\'s section so the loader accepts the file; off keeps everything', async t => {
  const p = project(t);
  p.write({ mode: 'server', server: { port: 9000 } });
  assert.equal(await p.save({ mode: 'client', host: 'h' }), undefined);
  assert.deepEqual(p.read(), { mode: 'client', client: { host: 'h', port: 7821 } });
  assert.equal(await p.save({ mode: 'server' }), undefined);
  assert.deepEqual(p.read(), { mode: 'server', server: { port: 7821 } });
  assert.equal(await p.save({ mode: 'off' }), undefined);
  assert.deepEqual(p.read(), { mode: 'off', server: { port: 7821 } });
  assert.equal((await loadRemoteConfig(p.dir, true)).kind, 'off');
});

test('name, wake and allowFrom are validated and normalized; defaults are not written', async t => {
  const p = project(t);
  assert.match((await p.save({ mode: 'server', name: 'Not A Name' })) ?? '', /^Enter a name of 1-24 characters/);
  assert.match((await p.save({ mode: 'server', wake: 'allowlist', allowFrom: 'mac-test, bad!' })) ?? '', /^Enter valid peer names.*"bad!" is not one/);
  assert.equal(await p.save({ mode: 'server', name: ' Win-Dev ', wake: 'allowlist', allowFrom: 'Mac-Test, linux-1' }), undefined);
  assert.deepEqual(p.read(), { mode: 'server', name: 'win-dev', wake: 'allowlist', allowFrom: ['mac-test', 'linux-1'], server: { port: 7821 } });
  assert.equal(await p.save({ name: '', wake: 'on', allowFrom: '' }), undefined);
  assert.deepEqual(p.read(), { mode: 'server', server: { port: 7821 } });
});

test('a failing credentials store is reported after the file was saved', async t => {
  const p = project(t);
  mkdirSync(dirname(p.credentialsPath), { recursive: true });
  writeFileSync(p.credentialsPath, '{ damaged');
  const result = await p.save({ mode: 'server' });
  assert.match(result ?? '', /^The settings were saved, but the pairing code could not be stored/);
  assert.deepEqual(p.read(), { mode: 'server', server: { port: 7821 } });
});

test('/settings:remote refuses an untrusted project; a trusted server panel shows its pairing code and a client panel its code state', async t => {
  const p = project(t);
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  registerRemoteSettings({ registerCommand: (name: string, command: never) => commands.set(name, command) } as unknown as ExtensionAPI, () => p.credentials);
  assert.deepEqual([...commands.keys()], ['settings:remote']);

  const notes: string[] = [];
  const screens: string[] = [];
  let nextPage = false;
  const ctx =(trusted: boolean) => ({
    cwd: p.dir, hasUI: true, mode: 'tui', isProjectTrusted: () => trusted,
    ui: {
      notify: (message: string) => notes.push(message),
      custom: async (factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }) => {
        const panel = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_c: string, text: string) => text, bold: (text: string) => text }, undefined, () => undefined);
        if (nextPage) panel.handleInput('\t');
        screens.push(panel.render(100).join('\n'));
        return false;
      },
      confirm: async () => false,
    },
  }) as unknown as ExtensionCommandContext;

  await commands.get('settings:remote')!.handler('', ctx(false));
  assert.deepEqual([notes, screens], [['Remote settings are only available in trusted projects.'], []]);

  nextPage = true; // the pairing code fields are on the Server / Client page
  p.write({ mode: 'server', server: { port: 7821 } });
  await commands.get('settings:remote')!.handler('', ctx(true));
  assert.match(screens[0]!, /Pairing code\s+[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}  \(Enter to regenerate\)/, 'a code is shown right away, without saving first');
  assert.equal(await p.credentials.peekServerCode(), undefined, 'merely opening the panel stores nothing');
  const code = await p.credentials.serverCode();
  await commands.get('settings:remote')!.handler('', ctx(true));
  assert.match(screens[1]!, new RegExp(`Pairing code\\s+${code}`), 'once stored, the stored code is shown');

  p.write({ mode: 'client', client: { host: 'h', port: 7821 } });
  await commands.get('settings:remote')!.handler('', ctx(true));
  assert.doesNotMatch(screens[2]!, /Pairing code\s+[A-Z2-9]{4}-/);
  assert.match(screens[2]!, /\(not set/i);
  await p.credentials.saveClientCode('h:7821', code);
  await commands.get('settings:remote')!.handler('', ctx(true));
  assert.match(screens[3]!, /configured; Enter to replace/);
  assert.doesNotMatch(screens[3]!, new RegExp(code.replace(/-/g, '')));
});
