// Timing check for the planned pre-compaction savepoint (plan/pi-auto-compact-plan.md §13): a real Pi AgentSession, Pi's own
// threshold compaction and a scripted offline provider whose reported usage is chosen per request. A probe-only extension appends a
// request draft at turn_end, exactly where the planned deadline trigger would. It does not load Pi Auto Compact, so it pins down
// Pi 1.5.0 behaviour that the design relies on, not the module itself.
// Scenarios: fits | overshoot | baseline | edge-over | edge-under. The last stdout line is the JSON result.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

assert.equal(sdk.VERSION, '1.5.0'); sdk.initTheme('dark', false);
const scenario = process.argv[2] ?? 'fits';
const home = homedir(), agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true }); await writeFile(join(agentDir, 'auth.json'), '{}');
const workspace = await realpath(cwd);

const WINDOW = 100000, RESERVE = 16384, THRESHOLD = WINDOW - RESERVE;
const REQUEST = 'PROBE-REQUEST '.concat('r'.repeat(386)); // 400 chars, about 100 estimated tokens
// One entry per normal request: the usage the provider reports for it and the size of the tool result the probe tool returns.
const STEPS = {
  fits: [{ usage: 30000, chars: 400 }, { usage: THRESHOLD - 3000, chars: 400 }, { usage: THRESHOLD - 2800, chars: 12000 }, { usage: 0, chars: 0 }],
  overshoot: [{ usage: 30000, chars: 400 }, { usage: THRESHOLD - 1000, chars: 12000 }, { usage: 0, chars: 0 }],
  baseline: [{ usage: 30000, chars: 400 }, { usage: THRESHOLD - 1000, chars: 12000 }, { usage: 0, chars: 0 }],
  // Just below the threshold at turn_end (the 400-char tool result adds 100): only the request draft decides whether Pi compacts first.
  'edge-over': [{ usage: 30000, chars: 400 }, { usage: THRESHOLD - 150, chars: 400 }, { usage: 0, chars: 0 }],
  'edge-under': [{ usage: 30000, chars: 400 }, { usage: THRESHOLD - 600, chars: 400 }, { usage: 0, chars: 0 }],
}[scenario];
assert.ok(STEPS, `unknown scenario ${scenario}`);
const askAt = scenario === 'baseline' ? -1 : { fits: 1, overshoot: 1, 'edge-over': 1, 'edge-under': 1 }[scenario];

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const timeline = [], seenByProvider = [];
let normal = 0, compacting = false, asked = false;
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('');
const offline = pi => {
  globalThis.fetch = async () => { throw new Error('External service calls are forbidden in the deadline timing fixture'); };
  pi.registerTool({ name: 'probe', label: 'Probe', description: 'Offline probe', parameters: Type.Object({ chars: Type.Number() }), defaultActive: true,
    async execute(_id, params) { return { content: [{ type: 'text', text: 'x'.repeat(params.chars) }], details: {} }; } });
  pi.on('turn_end', (event, ctx) => {
    const tokens = ctx.getContextUsage()?.tokens ?? null;
    timeline.push({ at: 'turn_end', tokens, threshold: THRESHOLD, ask: !asked && normal - 1 === askAt });
    if (asked || normal - 1 !== askAt) return undefined;
    asked = true;
    return { entries: [...event.entries, { type: 'custom_message', customType: 'probe:request', content: REQUEST, display: false }], continue: true };
  });
  pi.registerProvider('dl-offline', { api: 'dl-offline-api', baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'offline-not-secret',
    models: [{ id: 'fixture', name: 'Offline', reasoning: false, input: ['text'], cost: zero, contextWindow: WINDOW, maxTokens: 2048 }],
    streamSimple(model, context) {
      const summary = compacting;
      const last = context.messages.at(-1);
      const view = { call: summary ? 'summary' : `normal#${normal + 1}`, messages: context.messages.length, roles: context.messages.map(message => message.role).join(','), last: `${last?.role}: ${textOf(last).slice(0, 24)}`,
        sawRequest: context.messages.some(message => textOf(message).includes('PROBE-REQUEST')),
        sawSavepoint: context.messages.some(message => message.role === 'assistant' && textOf(message).includes('SAVEPOINT-ANSWER')),
        sawSummary: context.messages.some(message => textOf(message).includes('NATIVE_SUMMARY')) };
      timeline.push(view); seenByProvider.push(view);
      let content, stopReason = 'stop', usage = { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } };
      if (summary) content = [{ type: 'text', text: 'NATIVE_SUMMARY' }];
      else {
        const step = STEPS[normal]; normal++;
        assert.ok(step, `no scripted step for request ${normal}`);
        const answering = view.last.includes('PROBE-REQUEST');
        const text = answering ? 'SAVEPOINT-ANSWER' : step.chars === 0 ? 'All done.' : '';
        content = [...(text ? [{ type: 'text', text }] : []), ...(step.chars > 0 ? [{ type: 'toolCall', id: `probe-${normal}`, name: 'probe', arguments: { chars: step.chars } }] : [])];
        stopReason = step.chars > 0 ? 'toolUse' : 'stop';
        usage = { ...zero, input: step.usage, totalTokens: step.usage, cost: { ...zero, total: 0 } };
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, usage, stopReason };
        stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: stopReason, message }); stream.end();
      });
      return stream;
    } });
};

const sm = sdk.SessionManager.create(workspace, join(home, 'sessions'));
const text = value => [{ type: 'text', text: value }];
const emptyUsage = { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } };
// Enough old history that a compaction has something to summarize; its usage is zero, so the scripted requests set the estimate.
for (let i = 0; i < 12; i++) {
  sm.appendMessage({ role: 'user', content: `old request ${i}: ${'lorem ipsum '.repeat(40)}`, timestamp: Date.now() });
  sm.appendMessage({ role: 'assistant', content: text(`old answer ${i}: ${'dolor sit amet '.repeat(40)}`), api: 'dl-offline-api', provider: 'dl-offline', model: 'fixture', usage: structuredClone(emptyUsage), stopReason: 'stop', timestamp: Date.now() });
}
const settings = sdk.SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never', compaction: { enabled: true, reserveTokens: RESERVE, keepRecentTokens: 2000 } });
const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings, extensionFactories: [offline], noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const model = { provider: 'dl-offline', api: 'dl-offline-api', id: 'fixture', name: 'Offline', baseUrl: 'http://127.0.0.1:1/never-contacted', reasoning: false, input: ['text'], contextWindow: WINDOW, maxTokens: 2048, cost: zero };
const { session } = await sdk.createAgentSession({ cwd: workspace, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, model, sessionManager: sm });
const errors = []; await session.bindExtensions({ mode: 'json', onError: e => errors.push(e.error) });
session.subscribe(event => {
  if (event.type === 'compaction_start') { compacting = true; timeline.push({ at: 'compaction_start', reason: event.reason }); }
  if (event.type === 'compaction_end') { compacting = false; timeline.push({ at: 'compaction_end', reason: event.reason, aborted: event.aborted }); }
});

await session.prompt('Probe until you are done.');
await session.agent.waitForIdle?.();

const entries = (await readFile(sm.getSessionFile(), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const at = predicate => timeline.findIndex(predicate);
const isSavepoint = e => e.type === 'message' && e.message.role === 'assistant' && textOf(e.message).includes('SAVEPOINT-ANSWER');
const sessionAt = predicate => entries.findIndex(predicate);
const compactions = entries.filter(e => e.type === 'compaction').length;
const askEnd = at(e => e.at === 'turn_end' && e.ask), askedTokens = timeline[askEnd]?.tokens;
const compactionStart = at(e => e.at === 'compaction_start'), answerCall = at(e => e.call === 'normal#3');
const answerView = timeline[answerCall];
const check = (condition, message) => { if (!condition) throw new Error(`${message}\n${JSON.stringify(timeline, null, 1)}`); };

check(errors.length === 0, `no extension errors: ${JSON.stringify(errors)}`);
if (scenario === 'baseline') {
  // No request: compaction runs right after the turn whose estimate crossed the threshold.
  check(askEnd === -1, 'baseline appends no request');
  const crossing = at(e => e.at === 'turn_end' && e.tokens > THRESHOLD);
  check(crossing !== -1 && compactionStart > crossing, 'compaction follows the turn_end that crossed the threshold');
  check(compactions === 1, `one compaction, got ${compactions}`);
} else {
  check(askEnd !== -1 && typeof askedTokens === 'number', 'the request was appended at a turn_end with a known size');
  check(answerView && answerView.sawRequest && answerView.last.includes('PROBE-REQUEST'), 'the model is asked the request on its next normal request');
  check(sessionAt(isSavepoint) !== -1, 'the request was answered');
  const requestEntry = sessionAt(e => e.type === 'custom_message' && e.customType === 'probe:request');
  check(requestEntry !== -1 && requestEntry < sessionAt(isSavepoint), 'the request draft was persisted before its answer');
  // The budget Pi compares includes the draft, which turn_end's own size does not.
  if (scenario === 'fits' || scenario === 'edge-under') {
    check(askedTokens < THRESHOLD, 'the size at turn_end is below the threshold');
    check(compactionStart === -1 || compactionStart > answerCall, 'the request was answered before any compaction');
  }
  if (scenario === 'edge-under') { check(askedTokens + 150 < THRESHOLD, 'edge-under leaves room for the whole draft'); check(compactions === 0, 'no compaction ran'); }
  if (scenario === 'fits') {
    check(compactions === 1, `one compaction, got ${compactions}`);
    const after = timeline.find(e => e.call === 'normal#4');
    check(after && after.sawSummary && after.sawSavepoint, 'after the compaction the model still sees its savepoint answer next to the summary');
    check(sessionAt(isSavepoint) < sessionAt(e => e.type === 'compaction'), 'the savepoint was written before the compaction');
  }
  if (scenario === 'edge-over') {
    check(askedTokens < THRESHOLD && askedTokens + 150 > THRESHOLD, `turn_end reports a size just under the threshold: ${askedTokens}`);
    check(compactionStart > askEnd && compactionStart < answerCall, 'Pi counted the draft and compacted before the model could answer');
  }
  if (scenario === 'overshoot') {
    check(askedTokens > THRESHOLD, 'the size at turn_end is already over the threshold');
    check(compactionStart > askEnd && compactionStart < answerCall, 'compaction came before the answer');
  }
  if (scenario === 'overshoot' || scenario === 'edge-over') {
    // The request is not lost: it stays after the cut and is answered once the summary is in place.
    check(answerView.sawSummary && !answerView.sawSavepoint, 'the answer is given on top of the summary');
    check(sessionAt(e => e.type === 'compaction') > requestEntry && sessionAt(e => e.type === 'compaction') < sessionAt(isSavepoint), 'session order: request, compaction, answer');
    check(compactions === 1, `one compaction, got ${compactions}`);
  }
}
console.log(JSON.stringify({ status: 'passed', scenario, host: sdk.VERSION, threshold: THRESHOLD, askedTokens: askedTokens ?? null, compactions }));
process.exit(0);
