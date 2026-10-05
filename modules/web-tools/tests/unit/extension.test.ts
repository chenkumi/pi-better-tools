import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defaults, parseConfig } from '../../src/config.ts';
import { registerWebTools } from '../../src/index.ts';
import { NATIVE_GUIDANCE } from '../../src/native-openai.ts';
import { SOURCE_ENTRY_TYPE } from '../../src/native-sources.ts';
import type { logToolExecutionFailure } from '../../src/debug-log.ts';

function harness(provider: 'openai' | 'brave' | 'exa' = 'openai', enabled = true, capture = false, invalid = false,
  writeFailure?: typeof logToolExecutionFailure) {
  const tools: string[] = [], diagnostics: string[] = [];
  const definitions = new Map<string, Record<string, unknown>>();
  const hooks = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  let branch: { type: string; customType?: string; data?: unknown }[] = [];
  const config = defaults(); config.provider = provider; config.enabled = enabled; config.providers.openai.captureSources = capture;
  config.providers.brave = { apiKey: 'TEST_KEY' }; config.providers.exa = { apiKey: 'TEST_KEY' };
  const pi = {
    getActiveTools() { return tools; }, registerTool(t: { name: string } & Record<string, unknown>) { tools.push(t.name); definitions.set(t.name, t); },
    on(name: string, fn: Function) { hooks.set(name, fn); }, registerCommand(name: string, command: { handler: Function }) { commands.set(name, command); },
    appendEntry(customType: string, data: unknown) { branch.push({ type: 'custom', customType, data }); },
  } as unknown as ExtensionAPI;
  registerWebTools(pi, () => invalid ? parseConfig({ providers: { openai: { apiKey: 'SECRET' } } }) : config,
    message => diagnostics.push(message), writeFailure);
  const context = { hasUI: false, model: { api: 'openai-responses', provider: 'openai', id: 'fixture' }, sessionManager: { getBranch() { return branch; } } };
  return { tools, hooks, commands, diagnostics, context, definitions, config, branch: () => branch, switchBranch: (next: typeof branch) => { branch = next; } };
}
const terminal = (responseId: string) => ({ provider: 'openai', api: 'openai-responses', model: 'fixture', data: {
  type: 'response.completed', response: { id: responseId, status: 'completed', output: [{ type: 'web_search_call', action: { sources: [{ url: `https://source.example/${responseId}` }] } }] },
} });
const messageEnd = (responseId: string, stopReason = 'stop', model = 'fixture') => ({ message: { role: 'assistant', api: 'openai-responses', provider: 'openai', model, responseId, stopReason } });

test('OpenAI only registers fetch; REST modes expose output schemas and conservative hints', () => {
  assert.deepEqual(harness().tools, ['web_fetch']);
  for (const provider of ['brave', 'exa'] as const) {
    const h = harness(provider);
    assert.deepEqual(h.tools, ['web_fetch', 'web_search']);
    for (const definition of h.definitions.values()) {
      assert.ok(definition.outputSchema);
      assert.deepEqual(definition.namespace, { name: 'web', description: 'Public web fetching and explicit-provider search' });
      assert.deepEqual(definition.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    }
  }
  assert.deepEqual(harness('brave', false).tools, ['web_fetch']);
});
test('native hook restricted by model and mode; virtual payload model is never guessed', () => {
  const native = harness(), context = native.context, event = { payload: { tools: [], model: 'gpt-looks-openai' } };
  assert.deepEqual(native.hooks.get('before_provider_request')!(event, context).tools, [{ type: 'web_search' }]);
  assert.deepEqual(event.payload.tools, []);
  assert.ok(native.hooks.get('before_agent_start')!({ systemPrompt: 'Original' }, context).systemPrompt.startsWith('Original'));
  for (const model of [{ api: 'anthropic-messages', provider: 'anthropic' }, { api: 'pi-virtual', provider: 'router' }]) {
    assert.equal(native.hooks.get('before_provider_request')!(event, { ...context, model }), undefined);
  }
  assert.equal(harness('brave').hooks.get('before_provider_request')!(event, context), undefined);
  assert.equal(harness('openai', false).hooks.get('before_provider_request')!(event, context), undefined);
});
test('Codex native search works by default without TUI or headless warnings and respects mode gates', async () => {
  for (const hasUI of [false, true]) {
    const h = harness();
    const ctx = { ...h.context, hasUI, model: { api: 'openai-codex-responses', provider: 'openai-codex', id: 'fixture' },
      ui: { notify: (message: string) => h.diagnostics.push(message) } };
    h.hooks.get('session_start')!({}, ctx);
    h.hooks.get('model_select')!({}, ctx);
    assert.equal(h.hooks.get('before_agent_start')!({ systemPrompt: 'Original' }, ctx).systemPrompt, 'Original' + NATIVE_GUIDANCE);
    const event = { payload: { tools: [], include: [] } };
    const result = h.hooks.get('before_provider_request')!(event, ctx);
    assert.deepEqual(result.tools, [{ type: 'web_search' }]);
    assert.deepEqual(result.include, ['web_search_call.action.sources']);
    assert.deepEqual(event.payload, { tools: [], include: [] });
    assert.deepEqual(h.diagnostics, []);
    await h.commands.get('web-tools')!.handler('status', ctx);
    assert.match(h.diagnostics.at(-1)!, /Native OpenAI for current model: enabled/);
    assert.doesNotMatch(h.diagnostics.join(''), /experimental|opt-in.*Codex/i);
    for (const other of [harness('openai', false), harness('brave'), harness('exa')]) {
      assert.equal(other.hooks.get('before_provider_request')!(event, ctx), undefined);
      assert.equal(other.hooks.get('before_agent_start')!({ systemPrompt: 'Original' }, ctx), undefined);
    }
  }
});
test('Codex source capture remains opt-in and persists matching successful responses', () => {
  const h = harness('openai', true, true);
  const identity = { provider: 'openai-codex', api: 'openai-codex-responses' };
  h.context.model = { ...h.context.model, ...identity };
  h.hooks.get('provider_stream_event')!({ ...terminal('resp_codex'), ...identity }, h.context);
  const event = messageEnd('resp_codex');
  h.hooks.get('turn_end')!({ message: { ...event.message, ...identity } }, h.context);
  assert.equal(h.branch().length, 1);
  assert.equal((h.branch()[0]!.data as { provider: string }).provider, 'openai-codex');
});
test('modern prompt section preserves other handlers and custom prompts; disabling removes own section', () => {
  const h = harness(), options = { sections: { another_extension: 'Keep' }, customPrompt: 'User SYSTEM.md' };
  const event = { systemPrompt: 'User SYSTEM.md', systemPromptOptions: options };
  assert.equal(h.hooks.get('before_agent_start')!(event, h.context), undefined);
  assert.equal((options.sections as Record<string, string>).pi_web_tools_native_search, NATIVE_GUIDANCE.trim());
  assert.equal(options.sections.another_extension, 'Keep');
  assert.equal(options.customPrompt, 'User SYSTEM.md');
  assert.equal(h.hooks.get('before_agent_start')!(event, h.context), undefined);
  h.context.model = { api: 'pi-virtual', provider: 'router', id: 'auto' };
  assert.equal(h.hooks.get('before_agent_start')!(event, h.context), undefined);
  assert.deepEqual(options.sections, { another_extension: 'Keep' });
});
test('legacy and forced prompts are preserved without duplicate guidance', () => {
  const h = harness();
  const first = h.hooks.get('before_agent_start')!({ systemPrompt: 'Original' }, h.context);
  assert.equal(first.systemPrompt, 'Original' + NATIVE_GUIDANCE);
  assert.equal(h.hooks.get('before_agent_start')!({ systemPrompt: first.systemPrompt }, h.context), undefined);
  const event = { systemPrompt: 'Forced', systemPromptOptions: { sections: { other: 'Preserve' }, forceSystemPrompt: 'Forced' } };
  assert.equal(h.hooks.get('before_agent_start')!(event, h.context).systemPrompt, 'Forced' + NATIVE_GUIDANCE);
  h.context.model = { api: 'anthropic-messages', provider: 'anthropic', id: 'fixture' };
  assert.equal(h.hooks.get('before_agent_start')!({ systemPrompt: first.systemPrompt }, h.context).systemPrompt, 'Original');
});
test('conflict explicitly aborts even when runner swallows hook errors', () => {
  const h = harness(); h.tools.push('web_search');
  const abort = new AbortController(), ctx = { ...h.context, abort: () => abort.abort() };
  assert.equal(h.hooks.get('before_agent_start')!({ systemPrompt: 'Original' }, ctx), undefined);
  const payload = { tools: [{ type: 'function', name: 'web_search' }] };
  assert.throws(() => h.hooks.get('before_provider_request')!({ payload }, ctx), /TOOL_CONFLICT/);
  assert.equal(abort.signal.aborted, true);
  assert.equal(payload.tools[0]?.type, 'function');
});
test('headless virtual warning is explicit, deduplicated; status does not probe or expose secrets', async () => {
  const h = harness(); h.context.model = { api: 'pi-virtual', provider: 'router', id: 'auto' };
  h.hooks.get('session_start')!({}, h.context);
  h.hooks.get('model_select')!({}, h.context);
  assert.equal(h.diagnostics.length, 1);
  assert.match(h.diagnostics[0]!, /virtual routing is unsupported/);
  assert.match(h.diagnostics[0]!, /no injection or automatic fallback/);
  await h.commands.get('web-tools')!.handler('status', h.context);
  assert.match(h.diagnostics.at(-1)!, /inactive \(virtual routing/);
  assert.match(h.diagnostics.at(-1)!, /Browser service: not initialized/);
  assert.ok(!h.diagnostics.join('').includes('SECRET'));
});
test('invalid configuration fails closed for search, leaves lazy fetch, and has headless diagnostics', async () => {
  const h = harness('brave', true, true, true);
  assert.deepEqual(h.tools, ['web_fetch']);
  assert.ok(!h.hooks.has('provider_stream_event'));
  assert.equal(h.hooks.get('before_provider_request')!({ payload: {} }, h.context), undefined);
  h.hooks.get('session_start')!({}, h.context);
  await h.commands.get('web-tools')!.handler('status', h.context);
  assert.match(h.diagnostics[0]!, /CONFIG_INVALID/);
  assert.ok(!h.diagnostics.join('').includes('SECRET'));
});
test('source capture is opt-in; successful response identity, retry and abort stay separate', () => {
  assert.ok(!harness().hooks.has('provider_stream_event'));
  assert.ok(!harness('brave', true, true).hooks.has('provider_stream_event'));
  assert.ok(!harness('openai', false, true).hooks.has('provider_stream_event'));
  const h = harness('openai', true, true), stream = h.hooks.get('provider_stream_event')!, end = h.hooks.get('turn_end')!;
  stream(terminal('resp_wrong'), h.context); end(messageEnd('resp_wrong', 'stop', 'other-model'), h.context);
  assert.equal(h.branch().length, 0);
  for (const reason of ['error', 'aborted']) {
    stream(terminal(`resp_${reason}`), h.context); end(messageEnd(`resp_${reason}`, reason), h.context);
    stream(terminal(`resp_activity_${reason}`), h.context);
    end({ ...messageEnd(`resp_activity_${reason}`), outcome: reason }, h.context);
  }
  assert.equal(h.branch().length, 0);
  stream(terminal('resp_success'), h.context); end(messageEnd('resp_success'), h.context);
  assert.equal(h.branch().length, 1);
  assert.equal(h.branch()[0]!.customType, SOURCE_ENTRY_TYPE);
  stream(terminal('resp_success'), h.context); end(messageEnd('resp_success'), h.context);
  assert.equal(h.branch().length, 1, 'same response is not persisted twice');
  stream(terminal('resp_retry'), h.context); h.hooks.get('turn_start')!({}, h.context); end(messageEnd('resp_retry'), h.context);
  assert.equal(h.branch().length, 1, 'stale retry record is cleared');
});
test('sources command is branch-aware across reload/resume; shutdown drops pending captures', async () => {
  const h = harness('openai', true, true);
  h.hooks.get('provider_stream_event')!(terminal('resp_a'), h.context);
  h.hooks.get('turn_end')!(messageEnd('resp_a'), h.context);
  const branchA = [...h.branch()];
  await h.commands.get('web-tools')!.handler('sources', h.context);
  assert.match(h.diagnostics.at(-1)!, /https:\/\/source.example\/resp_a/);
  h.switchBranch([]); h.hooks.get('session_tree')!({}, h.context);
  await h.commands.get('web-tools')!.handler('sources', h.context);
  assert.match(h.diagnostics.at(-1)!, /No captured native sources/);
  const resumed = harness('openai', true, true); resumed.switchBranch(branchA);
  resumed.hooks.get('session_start')!({}, resumed.context);
  await resumed.commands.get('web-tools')!.handler('sources', resumed.context);
  assert.match(resumed.diagnostics.at(-1)!, /resp_a/);
  h.hooks.get('provider_stream_event')!(terminal('resp_pending'), h.context);
  await h.hooks.get('session_shutdown')!({}, h.context);
  h.hooks.get('turn_end')!(messageEnd('resp_pending'), h.context);
  assert.equal(h.branch().length, 0);
});
test('tool execution failures reach debug logger and preserve the original error without network access', async () => {
  const failures: Array<{ cwd: string; name: string; error: unknown }> = [];
  const h = harness('brave', true, false, false, async (ctx, name, error) => {
    failures.push({ cwd: ctx?.cwd ?? '', name, error });
  });
  h.config.providers.brave = { apiKeyEnv: 'PI_WEB_TOOLS_NONEXISTENT_TEST_KEY' };
  const searchTool = h.definitions.get('web_search')!.execute as Function;
  const context = { ...h.context, cwd: '/workspace/debug-project' };
  await assert.rejects(searchTool('test', { query: 'local test' }, undefined, undefined, context), /AUTH_REQUIRED/);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.cwd, context.cwd);
  assert.equal(failures[0]!.name, 'web_search');
  assert.match((failures[0]!.error as Error).message, /AUTH_REQUIRED/);
  const fetchTool = h.definitions.get('web_fetch')!.execute as Function;
  const abort = new AbortController(); abort.abort();
  await assert.rejects(fetchTool('test', { url: 'https://example.com/' }, abort.signal, undefined, context), /AbortError|aborted/i);
  assert.equal(failures.length, 2);
  assert.equal(failures[1]!.name, 'web_fetch');
});
test('shutdown racing the first lazy import cannot initialize or leave a browser service', async () => {
  const h = harness(), execute = h.definitions.get('web_fetch')!.execute as Function;
  const fetch = execute('race', { url: 'http://127.0.0.1/' }, undefined);
  await h.hooks.get('session_shutdown')!({}, h.context);
  await assert.rejects(fetch, /CANCELLED/);
  await h.commands.get('web-tools')!.handler('status', h.context);
  assert.match(h.diagnostics.at(-1)!, /Browser service: not initialized/);
  await assert.rejects(execute('after', { url: 'https://example.com/' }, undefined), /AbortError|CANCELLED|aborted/i);
});

test('web_search description names the configured provider and guidelines require sources and fetch', () => {
  for (const [provider, label] of [['brave', 'Brave'], ['exa', 'Exa']] as const) {
    const search = harness(provider).definitions.get('web_search')!;
    assert.ok(String(search.description).includes(`using ${label} (configured provider)`));
    assert.ok(!/provider argument/i.test(String(search.description)), 'description no longer mentions a provider argument');
    const guidelines = (search.promptGuidelines as string[]).join('\n');
    assert.match(guidelines, /source URL/);
    assert.match(guidelines, /1-3 most relevant results with web_fetch/);
    assert.match(guidelines, /snippets alone/);
    assert.match(guidelines, /Query tips/);
    assert.equal((search.parameters as { properties: Record<string, unknown> }).properties.provider, undefined, 'provider field removed from schema');
    const prepare = (search as unknown as { prepareArguments: (a: unknown) => unknown }).prepareArguments;
    assert.deepEqual(prepare({ query: 'q', provider: 'exa', numResults: 2 }), { query: 'q', numResults: 2 });
    assert.deepEqual(prepare({ query: 'q' }), { query: 'q' });
  }
  const fetchGuidelines = (harness('brave').definitions.get('web_fetch')!.promptGuidelines as string[]).join('\n');
  assert.match(fetchGuidelines, /BROWSER_UNAVAILABLE/);
  assert.match(fetchGuidelines, /npm run browser:install/);
});

test('web_search model-visible text omits the Provider line and clips long snippets, while structured data keeps them whole', async () => {
  const h = harness('brave');
  const searchTool = h.definitions.get('web_search')!.execute as Function;
  const longSnippet = '😀'.repeat(700); // 700 code points = 1400 UTF-16 units: must be cut on a code point boundary
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ web: { results: [
    { title: 'Long', url: 'https://example.com/long', description: longSnippet },
    { title: 'Short', url: 'https://example.com/short', description: 'short snippet' },
  ] } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const result = await searchTool('snippets', { query: 'clip test' }, undefined, undefined, { ...h.context, cwd: process.cwd() });
    const text = result.content[0].text as string;
    assert.ok(!/^Provider:/m.test(text), 'no Provider line in model-visible text');
    assert.match(text, /^Query: clip test/m);
    const clipped = /\[1\] Long\nhttps:\/\/example\.com\/long\n(.*)/.exec(text)?.[1] ?? '';
    assert.equal(Array.from(clipped).length, 601, '600 code points plus the ellipsis');
    assert.ok(clipped.endsWith('…'));
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(clipped), 'no lone surrogate from clipping');
    assert.match(text, /\[2\] Short\nhttps:\/\/example\.com\/short\nshort snippet/, 'short snippets are untouched');
    const data = (result.structuredContent as { data: { provider: string; results: { snippet?: string }[] } }).data;
    assert.equal(data.provider, 'brave');
    assert.equal(Array.from(data.results[0]!.snippet ?? '').length, 700, 'structured data keeps the whole snippet');
  } finally { globalThis.fetch = original; }
});
