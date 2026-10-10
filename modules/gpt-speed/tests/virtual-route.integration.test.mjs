// R05 (GPT Speed part) repro: gpt-speed's before_provider_request decides the injection ONLY from ctx.model
// (effectiveSpeedMode(mode, ctx.model)), while with a virtual model the request is sent to a different physical route.
// Correct behaviour: service_tier must follow the model that actually receives the request.
// Status: a virtual selected model is never injected (api === 'pi-virtual'); injection for a virtual->GPT route stays todo.
// Run: node --import tsx --test modules/gpt-speed/tests/virtual-route.integration.test.mjs
// Fidelity: real Pi 1.1.0 host + real gpt-speed extension + real virtual-model routing; the physical providers are
// offline fakes that call options.onPayload (= before_provider_request hooks) exactly like a real provider and record the result.
// No real OpenAI service is involved, so acceptance of `priority`/`ultrafast` by a real service is NOT verified here.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, after } from 'node:test';
import { makeSandbox, startHost, physicalModel } from '../../../tests/helpers/regression/host-r.mjs';

const sandbox = await makeSandbox('r05-speed');
after(() => sandbox.cleanup());
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const mk = (id) => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost });

async function run(label, { providers, virtual, select, mode = 'fast' }) {
  const spy = [];
  const opts = { sandbox, extensionPaths: ['modules/gpt-speed/src/index.ts'], providers,
    settings: { 'pi-gpt-speed': { mode } },
    factories: [(pi) => pi.on('before_provider_request', (_e, ctx) => { spy.push(`${ctx.model?.provider}/${ctx.model?.id}`); })],
    virtualModels: virtual ? [() => virtual] : [] };
  if (select.physical) opts.select = select.physical;
  const host = await startHost(opts);
  try {
    if (select.virtual) {
      const found = host.session.modelRuntime.getAllModels(select.virtual[0]).find((m) => m.id === select.virtual[1]);
      assert.ok(found, 'virtual model must be listed');
      await host.session.setModel(found);
    }
    console.error(`[R05-speed] ${label}: prompting (ctx.model before=${host.session.model?.provider}/${host.session.model?.id})`);
    await host.session.prompt('hello');
    const call = host.calls[0];
    console.error(`[R05-speed] ${label}: physical receiver=${call.model} ctx.model seen by hook=${spy[0]} payloadAfterHooks=${JSON.stringify(call.payloadAfterHooks)}`);
    return { call, spy };
  } finally { await host.close(); }
}

test('R05 control: direct physical openai/gpt-5.6-sol gets service_tier=priority in fast mode', { timeout: 90000 }, async () => {
  const providers = [{ name: 'openai', api: 'openai-responses', models: [mk('gpt-5.6-sol')] }];
  const { call } = await run('control-direct', { providers, select: { physical: ['openai', 'gpt-5.6-sol'] } });
  assert.equal(call.payloadAfterHooks?.service_tier, 'priority');
});

test('R05 virtual route -> physical openai/gpt-5.6-sol must receive service_tier=priority', { timeout: 90000, todo: 'capability boundary: Pi does not expose the routed physical model to before_provider_request; no public route info and no private runner' }, async () => {
  const providers = [{ name: 'openai', api: 'openai-responses', models: [mk('gpt-5.6-sol')] }];
  const virtual = { provider: 'router', id: 'auto', name: 'Offline router',
    route: (_req, ctx) => ({ model: ctx.modelRegistry.find('openai', 'gpt-5.6-sol'), thinkingLevel: 'off' }) };
  const { call } = await run('virtual->gpt', { providers, virtual, select: { virtual: ['router', 'auto'] } });
  assert.equal(call.model, 'openai/gpt-5.6-sol', 'physical receiver');
  assert.equal(call.payloadAfterHooks?.service_tier, 'priority', 'physical GPT route should get priority while fast mode is on (ctx.model was the virtual model)');
});

test('R05 virtual model that LOOKS like openai/gpt-5.7-astra but routes to a non-OpenAI physical model must not get service_tier', { timeout: 90000 }, async () => {
  const providers = [{ name: 'openai', api: 'openai-responses', models: [mk('gpt-5.6-sol')] }, { name: 'other-vendor', api: 'openai-completions', models: [mk('plain-model')] }];
  const virtual = { provider: 'openai', id: 'gpt-5.7-astra', name: 'Router that looks like GPT',
    route: (_req, ctx) => ({ model: ctx.modelRegistry.find('other-vendor', 'plain-model'), thinkingLevel: 'off' }) };
  const { call } = await run('virtual-lookalike->other', { providers, virtual, select: { virtual: ['openai', 'gpt-5.7-astra'] }, mode: 'ultrafast' });
  assert.equal(call.model, 'other-vendor/plain-model', 'physical receiver');
  assert.equal(call.payloadAfterHooks?.service_tier, undefined, 'a non-GPT physical route must not receive a GPT service_tier');
});
