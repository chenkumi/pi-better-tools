import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerDeferredTools } from '../src/deferred-tools.ts';

const own = (rel: string) => join(fileURLToPath(new URL('../../', import.meta.url)), rel);
const tool = (name: string, ns: string | undefined, path: string, exposure = 'deferred') =>
  ({ name, exposure, namespace: ns ? { name: ns, description: `${ns} group` } : undefined, sourceInfo: { path } });
const PTY = tool('pty_spawn', 'pty', own('pty-terminal/src/index.ts'));
const SCHED = tool('schedule_prompt', 'schedule', own('schedule-prompt/src/index.ts'));
const THIRD = tool('mcp_thing', 'mcp', 'D:/elsewhere/node_modules/x/index.js');

function host(all: any[], active: string[]) {
  const handlers = new Map<string, (event: any) => any>(); const calls: string[][] = []; let current = [...active];
  registerDeferredTools({ on: (e: string, h: any) => handlers.set(e, h), getAllTools: () => all,
    getActiveTools: () => [...current], setActiveTools: (n: string[]) => { calls.push(n); current = n; } } as never);
  const prompt = (extra: object = {}) => { const options: any = { sections: {}, ...extra }; return { options, result: handlers.get('before_agent_start')!({ systemPromptOptions: options, systemPrompt: options.forceSystemPrompt ?? 'base' }) }; };
  return { start: (reason: string) => handlers.get('session_start')!({ reason }), calls, active: () => current, setActive: (n: string[]) => { current = n; }, prompt };
}
const TS = { name: 'tool_search', exposure: 'active', sourceInfo: { path: 'builtin:tool_search' } };

test('fresh sessions activate a registered tool_search and leave deferred tools for it to load', () => {
  for (const reason of ['startup', 'new']) {
    const h = host([TS, PTY, SCHED], ['read']);
    h.start(reason);
    assert.deepEqual(h.active(), ['read', 'tool_search'], reason);
  }
});

test('resume, fork and reload never change the tool set', () => {
  for (const reason of ['resume', 'fork', 'reload']) { const h = host([TS, PTY], ['read']); h.start(reason); assert.equal(h.calls.length, 0, reason); }
});

test('without a registered tool_search, deferred tools of this package are declared directly; third-party ones are not', () => {
  const h = host([PTY, SCHED, THIRD], ['read']);
  h.start('startup');
  assert.deepEqual(h.active(), ['read', 'pty_spawn', 'schedule_prompt']);
});

test('nothing happens when there is no deferred tool, or tool_search is already active', () => {
  const none = host([TS], ['read']); none.start('startup'); assert.equal(none.calls.length, 0);
  const already = host([TS, PTY], ['read', 'tool_search']); already.start('startup'); assert.equal(already.calls.length, 0);
});

test('one hint lists each unloaded group of this package until it loads; third-party tools are not listed', () => {
  const h = host([TS, PTY, SCHED, THIRD], ['read', 'tool_search']);
  const first = h.prompt().options.sections.pi_better_tools_deferred_tools;
  assert.match(first, /- pty: pty group \(query "pty"\)/); assert.match(first, /- schedule: schedule group \(query "schedule"\)/); assert.doesNotMatch(first, /mcp/);
  h.setActive(['read', 'tool_search', 'pty_spawn']);
  const second = h.prompt().options.sections.pi_better_tools_deferred_tools;
  assert.doesNotMatch(second, /- pty:/); assert.match(second, /- schedule:/);
  h.setActive(['read', 'tool_search', 'pty_spawn', 'schedule_prompt']);
  assert.equal(h.prompt().options.sections.pi_better_tools_deferred_tools, undefined);
  const noSearch = host([PTY], ['read']);
  assert.equal(noSearch.prompt().options.sections.pi_better_tools_deferred_tools, undefined);
});

test('a forced system prompt gets the section appended once, updated as groups load, and cleaned at the end', () => {
  const h = host([TS, PTY, SCHED], ['read', 'tool_search']);
  const forced = h.prompt({ forceSystemPrompt: 'FORCED' });
  assert.match(forced.result.systemPrompt, /^FORCED\n\n### Deferred tools/);
  assert.equal(h.prompt({ forceSystemPrompt: forced.result.systemPrompt }).result, undefined, 'idempotent');
  h.setActive(['read', 'tool_search', 'pty_spawn']);
  const updated = h.prompt({ forceSystemPrompt: forced.result.systemPrompt }).result.systemPrompt;
  assert.doesNotMatch(updated, /- pty:/); assert.match(updated, /- schedule:/);
  h.setActive(['read', 'tool_search', 'pty_spawn', 'schedule_prompt']);
  assert.equal(h.prompt({ forceSystemPrompt: updated }).result.systemPrompt, 'FORCED');
});
