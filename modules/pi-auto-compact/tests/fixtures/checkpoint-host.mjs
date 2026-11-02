// Real Pi host check for the progress checkpoint: a real AgentSession with a scripted offline provider whose usage grows with
// every request. Scenarios: anchor (the anchor tool is active) | text (it is not). The last stdout line is the JSON result.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

assert.equal(sdk.VERSION, '1.5.0'); sdk.initTheme('dark', false);
const scenario = process.argv[2] ?? 'anchor';
const home = homedir(), agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true }); await writeFile(join(agentDir, 'auth.json'), '{}');
const workspace = await realpath(cwd);

const WINDOW = 100000, PER_REQUEST = 15000, PROBE_TURNS = 7;
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let requests = 0, providerCalls = 0;
const seen = [];
const lastText = context => { const m = context.messages.at(-1); return typeof m?.content === 'string' ? m.content : (m?.content ?? []).map(b => b.text ?? '').join(''); };
const offline = pi => {
  globalThis.fetch = async () => { throw new Error('External service calls are forbidden in the checkpoint host fixture'); };
  pi.registerTool({ name: 'probe', label: 'Probe', description: 'Offline probe', parameters: Type.Object({ n: Type.Number() }), defaultActive: true,
    async execute(_id, params) { return { content: [{ type: 'text', text: `probe ${params.n}` }], details: {} }; } });
  pi.registerProvider('cp-offline', { api: 'cp-offline-api', baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'offline-not-secret',
    models: [{ id: 'fixture', name: 'Offline', reasoning: false, input: ['text'], cost: zero, contextWindow: WINDOW, maxTokens: 2048 }],
    streamSimple(model, context) {
      providerCalls++; requests++;
      const incoming = lastText(context); seen.push(incoming);
      const asked = /Automatic progress checkpoint/.test(incoming), continued = /progress report is recorded/.test(incoming);
      let content, stopReason = 'stop';
      if (asked && scenario === 'anchor') { content = [{ type: 'toolCall', id: `anchor-${requests}`, name: 'progress_checkpoint', arguments: { summary: 'Probed three times; more probing next.' } }]; stopReason = 'toolUse'; }
      else if (asked) content = [{ type: 'text', text: 'Progress: probed three times; more probing next.' }];
      else if (continued) { content = [{ type: 'toolCall', id: `probe-${requests}`, name: 'probe', arguments: { n: requests } }]; stopReason = 'toolUse'; }
      else if (requests <= PROBE_TURNS) { content = [{ type: 'toolCall', id: `probe-${requests}`, name: 'probe', arguments: { n: requests } }]; stopReason = 'toolUse'; }
      else content = [{ type: 'text', text: 'All done.' }];
      const usage = { ...zero, input: requests * PER_REQUEST, totalTokens: requests * PER_REQUEST, cost: { ...zero, total: 0 } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, usage, stopReason };
        stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: stopReason, message }); stream.end();
      });
      return stream;
    } });
};

const sm = sdk.SessionManager.create(workspace, join(home, 'sessions'));
const settings = sdk.SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never', compaction: { enabled: false } });
const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings, additionalExtensionPaths: [entry], extensionFactories: [offline], noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model = { provider: 'cp-offline', api: 'cp-offline-api', id: 'fixture', name: 'Offline', baseUrl: 'http://127.0.0.1:1/never-contacted', reasoning: false, input: ['text'], contextWindow: WINDOW, maxTokens: 2048, cost: zero };
const { session } = await sdk.createAgentSession({ cwd: workspace, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model, sessionManager: sm });
const errors = []; await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
const anchorOn = scenario === 'anchor';
session.setActiveToolsByName(['probe', ...(anchorOn ? ['progress_checkpoint'] : [])]);
assert.equal(session.getActiveToolNames().includes('progress_checkpoint'), anchorOn);

await session.prompt('Probe until you are done.');
await session.agent.waitForIdle?.();

const entries = (await readFile(sm.getSessionFile(), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const customs = entries.filter(e => e.type === 'custom_message');
const checkpoints = customs.filter(e => e.customType === 'pi-auto-compact:checkpoint'), continues = customs.filter(e => e.customType === 'pi-auto-compact:continue');
assert.equal(checkpoints.length, 1, `exactly one checkpoint request: ${JSON.stringify(customs.map(e => e.customType))}`);
assert.match(String(checkpoints[0].content), anchorOn ? /Call progress_checkpoint now/ : /Write a brief progress report/);
const assistants = entries.filter(e => e.type === 'message' && e.message.role === 'assistant').map(e => e.message);
const anchors = assistants.filter(m => m.content.some(b => b.type === 'toolCall' && b.name === 'progress_checkpoint'));
const finalText = assistants.at(-1).content.map(b => b.text ?? '').join('');
assert.equal(finalText, 'All done.', 'the run went on to its natural end');
if (anchorOn) {
  assert.equal(anchors.length, 1); assert.equal(continues.length, 0, 'an anchor report needs no continuation');
  assert.ok(entries.some(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'progress_checkpoint'));
} else {
  assert.equal(anchors.length, 0); assert.equal(continues.length, 1, 'a text report that stopped the run is followed by one continuation');
  assert.ok(seen.some(text => /progress report is recorded/.test(text)));
}
assert.ok(seen.filter(text => /Automatic progress checkpoint/.test(text)).length === 1, 'the model saw the request once');
assert.equal(errors.length, 0, JSON.stringify(errors));
console.log(JSON.stringify({ status: 'passed', scenario, host: sdk.VERSION, providerCalls, requests, anchors: anchors.length, continues: continues.length }));
process.exit(0);
