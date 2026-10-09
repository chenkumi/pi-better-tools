import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { buildManagedChildEnvironment } from '../../extensions/subagent/child-args.ts';

const mode = process.argv[2], home = homedir(), agentDir = path.join(home, 'agent'), cwd = path.join(home, 'workspace');
const tracePath = path.join(home, 'trace.jsonl'), startupPath = path.join(home, 'startup.json');
const trace = data => fs.appendFileSync(tracePath, JSON.stringify({ ...data, pid: process.pid }) + '\n');
const fingerprint = () => {
  const info = fs.statSync(startupPath, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino), mtimeNs: String(info.mtimeNs) };
};
fs.mkdirSync(agentDir); fs.mkdirSync(cwd); fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
assert.equal(sdk.VERSION, '1.1.0');
globalThis.fetch = async () => { throw new Error('Network forbidden in guard reload fixture'); };
sdk.initTheme('dark', false);
const modelId = mode === 'unicode-stable' ? '多位-é-😀-模型' : ['replacement-character-stable', 'invalid-utf8'].includes(mode) ? 'offline-\uFFFD' : 'offline';
const model = { provider: 'reload-fixture', id: modelId, name: 'Offline reload', api: 'openai-completions', baseUrl: 'https://unused.invalid', reasoning: true,
  input: ['text'], contextWindow: 128000, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const manager = sdk.SessionManager.inMemory(cwd);
const expected = { id: manager.getSessionId(), cwd: fs.realpathSync(cwd), startupPath, model: `${model.provider}/${model.id}`, thinkingLevel: 'off', childTrusted: false, bridgeToken: 'offline-reload-token' };
const encoded = buildManagedChildEnvironment(expected).PI_SUBAGENTS_GUARD;
process.env.PI_SUBAGENTS_GUARD = encoded;
if (mode === 'foreign') fs.writeFileSync(startupPath, 'FOREIGN_RECEIPT', { flag: 'wx' });
const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['bash'], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }, { projectTrusted: false });
const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const guardPath = fileURLToPath(new URL('../../extensions/subagent/child-guard.ts', import.meta.url));
const shellPath = fileURLToPath(new URL('../../../shell-tools/src/index.ts', import.meta.url));
const provider = pi => pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-non-secret', models: [model],
  streamSimple(m) {
    trace({ phase: 'provider_admitted' });
    const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), content: [{ type: 'text', text: 'OFFLINE_OK' }], stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
    return stream;
  },
});
const resources = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [provider], additionalExtensionPaths: [shellPath, guardPath],
  noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
await resources.reload(); assert.deepEqual(resources.getExtensions().errors, []);
const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, model, thinkingLevel: 'off', sessionManager: manager, resourceLoader: resources });
const heartbeat = setInterval(() => console.log('Offline guard reload verification in progress...'), 5000);
try {
  await session.bindExtensions({ mode: 'json', onError: event => trace({ phase: 'extension_error', event: event.event, error: event.error }) });
  trace({ phase: 'first_bound', receipt: fs.readFileSync(startupPath, 'utf8'), fingerprint: fingerprint() });
  const receipt = fs.readFileSync(startupPath);
  if (mode === 'config') session.setThinkingLevel('low');
  if (mode === 'trust') globalThis.__piSubagentsGuardExpected.childTrusted = true;
  if (mode === 'new-invocation') process.env.PI_SUBAGENTS_GUARD = encoded; // identical full payload, fresh consumed object
  if (mode === 'tampered') fs.writeFileSync(startupPath, 'TAMPERED_RECEIPT');
  if (mode === 'same-size-tampered') fs.writeFileSync(startupPath, Buffer.concat([Buffer.from('x'), receipt.subarray(1)]));
  if (mode === 'invalid-utf8') {
    const before = fingerprint(), tampered = Buffer.from(receipt), offset = receipt.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
    assert.ok(offset >= 0);
    Buffer.from([0xf0, 0x90, 0x80]).copy(tampered, offset);
    assert.equal(tampered.length, receipt.length);
    assert.equal(tampered.toString('utf8'), receipt.toString('utf8'));
    fs.writeFileSync(startupPath, tampered);
    trace({ phase: 'invalid_utf8_mutation', before, after: fingerprint(), original: receipt.toString('base64'), tampered: tampered.toString('base64') });
  }
  if (mode === 'replacement') { fs.renameSync(startupPath, startupPath + '.owned'); fs.writeFileSync(startupPath, receipt, { flag: 'wx' }); }
  if (mode === 'missing') fs.unlinkSync(startupPath);
  trace({ phase: 'attempt_reload' });
  await session.reload();
  trace({ phase: 'reload_finished', receipt: fs.readFileSync(startupPath, 'utf8'), fingerprint: fingerprint(), schema: session.getToolDefinition('bash').parameters,
    managementPresent: ['shell_job_status', 'shell_job_cancel'].some(name => session.getToolDefinition(name)) });
  if (mode.endsWith('stable')) { await session.reload(); trace({ phase: 'second_reload_finished', fingerprint: fingerprint() }); }
  // Deliberate offline admission sentinel: old guard's swallowed EEXIST is observable.
  await session.prompt('Offline guard admission probe');
  trace({ phase: 'finished' });
} finally {
  clearInterval(heartbeat);
  await session.abort(); session.dispose();
}
