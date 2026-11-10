// Real Pi host check for the deadline checkpoint of Pi Auto Compact: a real AgentSession with this extension mounted, Pi's own threshold
// compaction (answered by this extension's deterministic summary, so no model call) and a scripted offline provider whose reported
// usage is chosen per request.
// Scenarios: reported | missed. The last stdout line is the JSON result.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

assert.equal(sdk.VERSION, '1.5.2'); sdk.initTheme('dark', false);
const scenario = process.argv[2] ?? 'reported';
const home = homedir(), agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true }); await writeFile(join(agentDir, 'auth.json'), '{}');
const workspace = await realpath(cwd);

const WINDOW = 100000, RESERVE = 16384, THRESHOLD = WINDOW - RESERVE, ZONE = THRESHOLD - 20000;
// Small budgets, so that the raw tail is short and the compaction really replaces most of the history.
await writeFile(join(agentDir, 'auto-compact.json'), JSON.stringify({ l1Ratio: 0.0001, l1MinChars: 3000, l2Ratio: 0.0001, l2MinChars: 1500, l3Ratio: 0.0001, l3MinChars: 1200, l4Ratio: 0.0001, l4MinChars: 1500, maxTotalRatio: 1 }));
const REPORT = 'Phase one is done: the parser reads all rules. Rule engine is in progress; the lexer tests come next.';
// One entry per normal request: the usage the provider reports and the tool result size the probe tool returns (0: answer and stop).
// `reported`: the size at turn_end reaches the zone on request 4, the model answers the notice with a progress_checkpoint call on request 5, then the run grows past the threshold.
// `missed`: one response reports a size already over the threshold (jumping from below the zone), so Pi compacts right after it and no notice is sent.
const STEPS = {
  reported: [{ usage: 20000, chars: 400 }, { usage: 45000, chars: 400 }, { usage: 55000, chars: 400 }, { usage: ZONE, chars: 400 }, { usage: ZONE + 400, chars: 12000 }, { usage: THRESHOLD - 2500, chars: 12000 }, { usage: 0, chars: 0 }],
  missed: [{ usage: 20000, chars: 400 }, { usage: 45000, chars: 400 }, { usage: 60000, chars: 400 }, { usage: THRESHOLD + 1000, chars: 12000 }, { usage: 0, chars: 0 }],
}[scenario];
assert.ok(STEPS, `unknown scenario ${scenario}`);

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('');
const seen = [];
let normal = 0, providerCalls = 0;
const offline = pi => {
  globalThis.fetch = async () => { throw new Error('External service calls are forbidden in the deadline host fixture'); };
  pi.registerTool({ name: 'probe', label: 'Probe', description: 'Offline probe', parameters: Type.Object({ chars: Type.Number() }), defaultActive: true,
    async execute(_id, params) { return { content: [{ type: 'text', text: 'x'.repeat(params.chars) }], details: {} }; } });
  pi.registerProvider('dh-offline', { api: 'dh-offline-api', baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'offline-not-secret',
    models: [{ id: 'fixture', name: 'Offline', reasoning: false, input: ['text'], cost: zero, contextWindow: WINDOW, maxTokens: 2048 }],
    streamSimple(model, context) {
      providerCalls++;
      const step = STEPS[normal]; normal++;
      assert.ok(step, `no scripted step for request ${normal}`);
      const last = context.messages.at(-1);
      const asked = /compaction will happen soon/.test(textOf(last));
      seen.push({ request: normal, asked, messages: context.messages.length, sawSummary: context.messages.some(message => /pi-auto-compact|Goal \(first request\)/.test(textOf(message))),
        sawReport: context.messages.some(message => textOf(message).includes(REPORT) || JSON.stringify(message.content ?? '').includes(REPORT)) });
      const usage = { ...zero, input: step.usage, totalTokens: step.usage, cost: { ...zero, total: 0 } };
      let content, stopReason = 'toolUse';
      if (asked) content = [{ type: 'toolCall', id: `checkpoint-${normal}`, name: 'progress_checkpoint', arguments: { summary: REPORT } }];
      else if (step.chars > 0) content = [{ type: 'toolCall', id: `probe-${normal}`, name: 'probe', arguments: { chars: step.chars } }];
      else { content = [{ type: 'text', text: 'All done.' }]; stopReason = 'stop'; }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, usage, stopReason };
        stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: stopReason, message }); stream.end();
      });
      return stream;
    } });
};

const sm = sdk.SessionManager.create(workspace, join(home, 'sessions'));
const settings = sdk.SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never', compaction: { enabled: true, reserveTokens: RESERVE, keepRecentTokens: 2000 } });
const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings, additionalExtensionPaths: [entry], extensionFactories: [offline], noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model = { provider: 'dh-offline', api: 'dh-offline-api', id: 'fixture', name: 'Offline', baseUrl: 'http://127.0.0.1:1/never-contacted', reasoning: false, input: ['text'], contextWindow: WINDOW, maxTokens: 2048, cost: zero };
const { session } = await sdk.createAgentSession({ cwd: workspace, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model, sessionManager: sm });
const errors = []; await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
session.setActiveToolsByName(['probe', 'progress_checkpoint']);
assert.ok(session.getActiveToolNames().includes('progress_checkpoint'));

await session.prompt('Work through the task until you are done.');
await session.agent.waitForIdle?.();

const entries = (await readFile(sm.getSessionFile(), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const requests = entries.filter(e => e.type === 'custom_message' && e.customType === 'pi-auto-compact:deadline');
const compactions = entries.filter(e => e.type === 'compaction');
const anchors = entries.filter(e => e.type === 'message' && e.message.role === 'assistant' && e.message.content.some(b => b.type === 'toolCall' && b.name === 'progress_checkpoint'));
const finalText = entries.filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1).message.content.map(b => b.text ?? '').join('');
const fail = message => { throw new Error(`${message}\n${JSON.stringify({ seen, requests: requests.length, compactions: compactions.length }, null, 1)}`); };
const check = (condition, message) => { if (!condition) fail(message); };

check(errors.length === 0, `no extension errors: ${JSON.stringify(errors)}`);
check(finalText === 'All done.', `the run reached its natural end: ${finalText}`);
check(compactions.length === 1, `one compaction, got ${compactions.length}`);
check(compactions[0].details?.compactor === 'pi-auto-compact', 'the compaction is this extension\'s deterministic one, not Pi\'s native summary');
check(providerCalls === STEPS.length, `no model call for the summary: ${providerCalls} calls for ${STEPS.length} requests`);
const after = seen.find(s => s.request > seen.findIndex(x => x.asked) + 1 && s.sawSummary);
if (scenario === 'reported') {
  check(requests.length === 1, `exactly one notice, got ${requests.length}`);
  const askedAt = seen.findIndex(s => s.asked);
  check(askedAt === 4, `the notice reached the model on request 5 (after the turn that entered the zone), got ${askedAt + 1}`);
  check(anchors.length === 1, 'the model answered with a progress_checkpoint call');
  check(entries.indexOf(compactions[0]) > entries.indexOf(anchors[0]), 'the checkpoint was saved before the compaction');
  check(after && after.sawSummary, 'the model sees the summary after the compaction');
  check(after.sawReport, 'the summary carries the checkpoint text itself (Latest checkpoint), not a path to a file');
} else {
  check(requests.length === 0, `no notice when the size jumped over the threshold in one turn, got ${requests.length}`);
  check(anchors.length === 0, 'no checkpoint was written');
}
console.log(JSON.stringify({ status: 'passed', scenario, host: sdk.VERSION, requests: requests.length, anchors: anchors.length, compactions: compactions.length }));
process.exit(0);
