// Deferred tools of this package load on demand without any defaultTools setting; pi-runtime owns the activation, the
// fallback and the single discovery hint. Level: real Pi AgentSession + real module entries + the built-in tool_search
// extension. No provider calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHost, entry, heartbeat, isolate, text } from '../../../tests/helpers/regression/host.mjs';

const PTY = ['pty_spawn', 'pty_write', 'pty_read', 'pty_resize', 'pty_wait_exit', 'pty_kill', 'pty_list'];
const HINT = '### Deferred tools';

async function host(prefix, { withToolSearch }) {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const env = await isolate(prefix);
  const created = await createHost({ env, defaultTools: ['read'],
    extensionPaths: ['pi-runtime', 'pty-terminal', 'schedule-prompt'].map(name => entry(`modules/${name}/src/index.ts`)),
    extensionFactories: withToolSearch ? [sdk.createToolSearchExtension()] : [] });
  await created.bind();
  assert.deepEqual(created.loadErrors(), []);
  const names = () => created.session.getActiveToolNames();
  const section = async () => (await created.session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'x' },
    { cwd: env.cwd, tools: [], skills: [], contextFiles: [], sections: {} })).systemPromptOptions.sections.pi_better_tools_deferred_tools;
  const all = async () => (await created.session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'x' },
    { cwd: env.cwd, tools: [], skills: [], contextFiles: [], sections: {} })).systemPromptOptions.sections;
  return { created, names, section, all };
}

test('default settings: tool_search is activated, deferred tools stay unloaded, the hint lists them, searches load them', { timeout: 120000 }, async () => {
  const stop = heartbeat('deferred-tools');
  const { created, names, section, all } = await host('deferred', { withToolSearch: true });
  try {
    assert.ok(names().includes('tool_search'), 'tool_search is activated without defaultTools');
    // schedule_prompt is declared directly (not deferred), so it is active without tool_search and is never listed in the hint.
    assert.ok(names().includes('schedule_prompt'), 'a directly declared module tool is active from the start');
    assert.ok(!names().includes('pty_spawn'));
    const rules = (await all()).pi_better_tools_cross_tool_rules;
    assert.match(rules, /^### Cross-tool rules/); assert.doesNotMatch(rules, /Delegate/, 'only blocks for active tools');
    const hint = await section();
    assert.match(hint, /- pty: .*\(query "pty"\)/); assert.doesNotMatch(hint, /- schedule:/, 'a directly declared tool has no deferred group');
    const [pty] = await created.callTools({ name: 'tool_search', arguments: { query: 'pty' } });
    assert.ok(!pty.isError, text(pty));
    assert.deepEqual(PTY.filter(n => names().includes(n)), PTY);
    assert.equal(await section(), undefined, 'hint disappears once every deferred group is loaded');
    await created.session.reload();
    assert.ok(names().includes('schedule_prompt') && names().includes('pty_spawn'), 'active tools survive /reload');
  } finally { stop(); await created.close(); }
});

test('without a registered tool_search the deferred tools are declared directly and no hint is added', { timeout: 120000 }, async () => {
  const stop = heartbeat('deferred-fallback');
  const { created, names, section } = await host('deferred-fallback', { withToolSearch: false });
  try {
    assert.ok(!names().includes('tool_search'));
    assert.ok(PTY.every(n => names().includes(n)) && names().includes('schedule_prompt'));
    assert.equal(await section(), undefined);
  } finally { stop(); await created.close(); }
});
