import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { remoteConfigPath } from '../src/config.js';
import { CredentialStore } from '../src/credentials.js';
import remoteExtension, { inboundText } from '../src/index.js';
import { Changes } from './helpers.js';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionContext) => unknown };
interface Sent { message: { customType: string; content: string; display: boolean; details: Record<string, unknown> }; options: { triggerTurn?: boolean; deliverAs?: string } }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
  });
}

/** One Pi session with the extension loaded against a fake host, in its own project directory and credentials home. */
function session(t: TestContext, options: { config?: unknown; raw?: string; trusted?: boolean; hasUI?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-remote-ext-'));
  const credentials = new CredentialStore(join(dir, 'home', 'pi-remote.json'));
  const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, Handler>(), commands = new Map<string, Command>(), statuses: Array<string | undefined> = [];
  const sent: Sent[] = [], notices: Array<{ message: string; type: string }> = [], changes = new Changes();
  const ctx = { cwd: dir, hasUI: options.hasUI ?? true, isProjectTrusted: () => options.trusted ?? true, ui: { notify: (message: string, type: string) => { notices.push({ message, type }); changes.notify(); }, setStatus: (_key: string, text: string | undefined) => { statuses.push(text); changes.notify(); } } } as unknown as ExtensionContext;
  const api = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    sendMessage: (message: Sent['message'], sendOptions: Sent['options']) => { sent.push({ message, options: sendOptions }); changes.notify(); },
  } as unknown as ExtensionAPI;
  remoteExtension(api, { credentials, backoff: () => 5 });
  const write = (value: unknown) => { mkdirSync(dirname(remoteConfigPath(dir)), { recursive: true }); writeFileSync(remoteConfigPath(dir), typeof value === 'string' ? value : JSON.stringify(value)); };
  if (options.raw !== undefined) write(options.raw); else if (options.config !== undefined) write(options.config);
  const run = async (name: string) => { await handlers.get(name)?.({ type: name, reason: 'startup' }, ctx); };
  t.after(async () => { await run('session_shutdown'); rmSync(dir, { recursive: true, force: true }); });
  const call = async (name: string, params: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `Missing tool: ${name}`);
    const result = await tool.execute('call', params as never, undefined, undefined, ctx as unknown as ExtensionToolContext);
    const content = result.content[0];
    return JSON.parse(content?.type === 'text' ? content.text : '{}') as Record<string, any>;
  };
  /** Runs the before_agent_start hook the way the host does and returns the resulting prompt pieces. */
  const beforeStart = (extra: { forceSystemPrompt?: string; systemPrompt?: string } = {}) => {
    const sections: Record<string, string> = {};
    const event = { systemPrompt: extra.systemPrompt ?? '', systemPromptOptions: { sections, ...(extra.forceSystemPrompt === undefined ? {} : { forceSystemPrompt: extra.forceSystemPrompt }) } };
    const result = handlers.get('before_agent_start')?.(event, ctx) as { systemPrompt: string } | undefined;
    return { sections, result };
  };
  return { dir, credentials, tools, commands, statuses, beforeStart, sent, notices, changes, ctx, call, start: () => run('session_start'), shutdown: () => run('session_shutdown'), write };
}

/** A running server session plus a paired client session. */
async function pair(t: TestContext, serverConfig: Record<string, unknown> = {}) {
  const port = await freePort();
  const server = session(t, { config: { mode: 'server', name: 'srv', server: { port }, ...serverConfig } });
  await server.start();
  const client = session(t, { config: { mode: 'client', name: 'cli', client: { host: '127.0.0.1', port, tls: false } } });
  await client.credentials.saveClientCode(`127.0.0.1:${port}`, await server.credentials.serverCode());
  await client.start();
  const online = async () => { for (let i = 0; i < 200; i += 1) { if ((await client.call('remote_status')).state === 'connected') return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('client never connected'); };
  await online();
  return { port, server, client };
}

test('nothing is registered or opened when the file is missing, off, or the project is untrusted', async t => {
  for (const options of [{}, { config: { mode: 'off' } }, { config: { mode: 'server', server: { port: 1 } }, trusted: false }]) {
    const s = session(t, options);
    await s.start();
    assert.equal(s.tools.size, 0);
    assert.deepEqual(s.notices, []);
  }
});

test('a bad config is reported to the human and registers no tools', async t => {
  for (const options of [{ raw: '{ nope' }, { config: { mode: 'server', server: { port: 1 }, tokenEnv: 'X' } }]) {
    const s = session(t, options);
    await s.start();
    assert.equal(s.tools.size, 0);
    assert.equal(s.notices.length, 1);
    assert.match(s.notices[0]!.message, /Remote is off: .*remote\.json/);
    assert.equal(s.notices[0]!.type, 'error');
  }
});

test('tools are deferred in the remote namespace and never default-active', async t => {
  const { server } = await pair(t);
  assert.deepEqual([...server.tools.keys()].sort(), ['remote_list', 'remote_send', 'remote_status']);
  for (const tool of server.tools.values()) {
    assert.equal(tool.exposure, 'deferred', tool.name);
    assert.equal(tool.namespace?.name, 'remote', tool.name);
    assert.match(tool.namespace?.description ?? '', /tool_search/);
    assert.notEqual(tool.defaultActive, true, tool.name);
  }
});

test('peers see each other, and a message arrives labelled as untrusted data that wakes the agent through steer', async t => {
  const { server, client } = await pair(t);
  const listed = await server.call('remote_list');
  assert.equal(listed.name, 'srv');
  assert.deepEqual(listed.peers.map((p: { name: string; self?: boolean }) => [p.name, p.self ?? false]), [['srv', true], ['cli', false]]);
  assert.equal(listed.peers[1].platform, process.platform);

  const receipt = await client.call('remote_send', { name: 'srv', message: 'please run the tests', kind: 'sync', git: { branch: 'main', commit: 'abc123' } });
  assert.equal(receipt.status, 'delivered');
  await server.changes.until(() => server.sent.length === 1, 'server received');
  const { message, options } = server.sent[0]!;
  assert.equal(message.customType, 'remote_message');
  assert.equal(message.display, true);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: 'steer' });
  assert.equal(message.details.from, 'cli');
  assert.match(message.content, /\[Remote message from "cli" · kind: sync · id: [0-9A-Z]+\]/);
  assert.match(message.content, /not an instruction from the user/);
  assert.match(message.content, /Git: branch=main, commit=abc123/);
  assert.match(message.content, /--- begin message ---\nplease run the tests\n--- end message ---/);
  assert.match(message.content, /remote_send with name "cli"/);

  assert.deepEqual((await client.call('remote_status', { id: receipt.id })).sends.map((s: { id: string; status: string }) => [s.id, s.status]), [[receipt.id, 'delivered']]);
  assert.equal((await client.call('remote_send', { name: 'ghost', message: 'x' })).status, 'offline');
});

test('wake "off" delivers without starting a turn; "allowlist" wakes only listed peers', async t => {
  const off = await pair(t, { wake: 'off' });
  await off.client.call('remote_send', { name: 'srv', message: 'hi' });
  await off.server.changes.until(() => off.server.sent.length === 1, 'delivered');
  assert.deepEqual(off.server.sent[0]!.options, { triggerTurn: false, deliverAs: 'steer' });

  const listed = await pair(t, { wake: 'allowlist', allowFrom: ['cli'] });
  await listed.client.call('remote_send', { name: 'srv', message: 'hi' });
  await listed.server.changes.until(() => listed.server.sent.length === 1, 'delivered');
  assert.equal(listed.server.sent[0]!.options.triggerTurn, true);

  const unlisted = await pair(t, { wake: 'allowlist', allowFrom: ['someone-else'] });
  await unlisted.client.call('remote_send', { name: 'srv', message: 'hi' });
  await unlisted.server.changes.until(() => unlisted.server.sent.length === 1, 'delivered');
  assert.equal(unlisted.server.sent[0]!.options.triggerTurn, false);
});

test('a chatty peer can wake the agent only three times a minute; the rest still arrive', async t => {
  const { server, client } = await pair(t);
  for (let i = 0; i < 5; i += 1) await client.call('remote_send', { name: 'srv', message: `m${i}` });
  await server.changes.until(() => server.sent.length === 5, 'all delivered');
  assert.deepEqual(server.sent.map(s => s.options.triggerTurn), [true, true, true, false, false]);
});

test('a server on a busy port reports a fault, does not fall back to client, and its tools refuse to send', async t => {
  const first = session(t, { config: { mode: 'server', server: { port: await freePort() } } });
  await first.start();
  const port = Number(((await first.call('remote_status')).address as string).split(':').at(-1));
  const second = session(t, { config: { mode: 'server', server: { port } } });
  await second.start();
  const status = await second.call('remote_status');
  assert.equal(status.state, 'fault');
  assert.equal(status.role, 'server');
  assert.equal(second.notices.length, 1);
  assert.match(second.notices[0]!.message, /could not start.*EADDRINUSE/);
  await assert.rejects(second.call('remote_send', { name: 'x', message: 'y' }), /not connected \(fault\)/);
});

test('a client without a pairing code asks for one instead of connecting; a wrong code is reported as refused', async t => {
  const port = await freePort();
  const server = session(t, { config: { mode: 'server', server: { port } } });
  await server.start();
  const noCode = session(t, { config: { mode: 'client', client: { host: '127.0.0.1', port, tls: false } } });
  await noCode.start();
  assert.equal((await noCode.call('remote_status')).state, 'needs_code');
  assert.match(noCode.notices[0]!.message, /needs a pairing code/);

  const wrong = session(t, { config: { mode: 'client', client: { host: '127.0.0.1', port, tls: false } } });
  await wrong.credentials.saveClientCode(`127.0.0.1:${port}`, 'ABCD-EFGH-JKLM');
  await wrong.start();
  await wrong.changes.until(() => wrong.notices.some(n => /was refused/.test(n.message)), 'refusal notice');
  assert.equal((await wrong.call('remote_status')).state, 'auth_failed');
  assert.deepEqual((await server.call('remote_list')).peers.map((p: { name: string }) => p.name).length, 1);
});

test('shutdown closes the connection: the peer sees the server go and sends fail until it returns', async t => {
  const { server, client, port } = await pair(t);
  await server.shutdown();
  for (let i = 0; i < 200 && (await client.call('remote_status')).state === 'connected'; i += 1) await new Promise(resolve => setTimeout(resolve, 25));
  assert.notEqual((await client.call('remote_status')).state, 'connected');
  await assert.rejects(client.call('remote_send', { name: 'srv', message: 'x' }), /not connected/);
  assert.ok(port > 0);
});

test('inbound text shape stays stable for replies and carries no unsanitized names', () => {
  const text = inboundText({ id: 'I1', from: 'win-1', kind: 'message', body: 'hello', replyTo: 'R1' });
  assert.match(text, /^\[Remote message from "win-1" · kind: message · id: I1 · reply to: R1\]/);
  assert.doesNotMatch(text, /Git:/);
});

test('the system prompt gets a roster section naming the other peers, and loses it when the network is gone', async t => {
  const { server, client } = await pair(t);
  await server.changes.until(() => server.beforeStart().sections.pi_better_tools_remote?.includes('cli') ?? false, 'server roster lists cli');
  const section = server.beforeStart().sections.pi_better_tools_remote!;
  assert.match(section, /This session is "srv"/);
  assert.match(section, /- cli \(/);
  assert.match(client.beforeStart().sections.pi_better_tools_remote ?? '', /- srv \(/);
  assert.equal(server.beforeStart().result, undefined, 'a normal prompt is left to the structured section');

  await server.shutdown();
  assert.equal(server.beforeStart().sections.pi_better_tools_remote, undefined);
});

test('a forced prompt from another extension keeps one current copy of the roster section', async t => {
  const { server } = await pair(t);
  await server.changes.until(() => (server.beforeStart({ forceSystemPrompt: 'FORCED', systemPrompt: 'FORCED' }).result?.systemPrompt ?? '').includes('cli'), 'forced prompt carries the roster');
  const first = server.beforeStart({ forceSystemPrompt: 'FORCED', systemPrompt: 'FORCED' }).result!.systemPrompt;
  assert.match(first, /^FORCED\n\n### Remote network/);
  assert.equal(server.beforeStart({ forceSystemPrompt: first, systemPrompt: first }).result, undefined, 'already current: unchanged');
  await server.shutdown();
  assert.equal(server.beforeStart({ forceSystemPrompt: first, systemPrompt: first }).result?.systemPrompt, 'FORCED');
});

test('an off session adds nothing to the prompt and /remote explains how to turn Remote on', async t => {
  const s = session(t);
  await s.start();
  assert.deepEqual(s.beforeStart(), { sections: {}, result: undefined });
  await s.commands.get('remote')!.handler('', s.ctx);
  assert.match(s.notices.at(-1)!.message, /Remote is off\. Configure it in .*remote\.json/);
});

test('the footer follows the connection and /remote reports the live network', async t => {
  const { server, client } = await pair(t);
  await server.changes.until(() => server.statuses.at(-1) === 'remote srv · 1 peer', 'server footer shows one peer');
  await client.changes.until(() => client.statuses.at(-1) === 'remote cli · 1 peer', 'client footer shows the server');
  await server.commands.get('remote')!.handler('', server.ctx);
  const report = server.notices.at(-1)!;
  assert.equal(report.type, 'info');
  assert.match(report.message, /^Remote · server · listening\nName: srv\nAddress: ws:\/\/127\.0\.0\.1:\d+ \(unencrypted\)/);
  assert.match(report.message, /  srv \(you\) ·/);
  assert.match(report.message, /  cli ·/);
  await server.shutdown();
  assert.equal(server.statuses.at(-1), undefined, 'footer cleared on shutdown');
});

test('a faulted session shows a fault footer and no roster', async t => {
  const first = session(t, { config: { mode: 'server', server: { port: await freePort() } } });
  await first.start();
  const port = Number(((await first.call('remote_status')).address as string).split(':').at(-1));
  const second = session(t, { config: { mode: 'server', server: { port } } });
  await second.start();
  assert.equal(second.statuses.at(-1), 'remote · fault');
  assert.deepEqual(second.beforeStart().sections, {});
});
