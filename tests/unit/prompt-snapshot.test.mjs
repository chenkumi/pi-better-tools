import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Golden text of the tool-rule prompt sections for representative active-tool sets, produced by the real owner
// extensions in manifest order (so it also pins section order, which the provider cache prefix depends on).
// A change to wording, split or order must regenerate it on purpose:
//   UPDATE_PROMPT_SNAPSHOT=1 node --import tsx --test tests/unit/prompt-snapshot.test.mjs
const GOLDEN = new URL('../fixtures/prompt-snapshot.json', import.meta.url);
const home = await mkdtemp(join(tmpdir(), 'prompt-snapshot-'));
process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
process.env.HOME = process.env.USERPROFILE = home;

const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).pi.extensions;
const OWNERS = ['shell-tools', 'file-tools', 'subagents', 'web-tools', 'pi-runtime', 'fork', 'schedule-commands'];
const handlers = [];
let active = [];
const noop = () => undefined;
const pi = new Proxy({}, {
  get: (_t, key) => key === 'on' ? (name, handler) => { if (name === 'before_agent_start') handlers.push(handler); }
    : key === 'getActiveTools' ? () => [...active]
    : key === 'getAllTools' ? () => []
    : key === 'events' ? { on: noop, emit: noop } : noop,
});
for (const entry of manifest.filter(path => OWNERS.some(name => path === `./modules/${name}/src/index.ts`))) {
  const loaded = await import(new URL(`../../${entry.replace(/^\.\//, '')}`, import.meta.url).href);
  await loaded.default(pi);
}

const SETS = {
  'read only': ['read'],
  'shell only': ['bash'],
  'shell + file': ['bash', 'read', 'grep', 'find', 'ls', 'edit', 'write'],
  'shell + file + web': ['powershell', 'read', 'grep', 'find', 'ls', 'edit', 'write', 'web_fetch', 'web_search'],
  'shell + file + subagent': ['bash', 'read', 'edit', 'subagent'],
  'shell + file + subagent + fork': ['bash', 'read', 'edit', 'write', 'subagent', 'fork'],
  'shell + schedule': ['bash', 'schedule_prompt', 'schedule_shell'],
};

/** Runs every before_agent_start handler like Pi does (each sees the sections and forced prompt left by the previous). */
async function sectionsFor(tools, forced) {
  active = tools;
  const options = { sections: {}, ...(forced === undefined ? {} : { forceSystemPrompt: forced }) };
  const ctx = { cwd: home, isProjectTrusted: () => false, hasUI: false, model: undefined, ui: { notify: noop, setStatus: noop } };
  let systemPrompt = forced ?? 'built';
  for (const handler of handlers) {
    let result;
    try { result = await handler({ systemPrompt, systemPromptOptions: options }, ctx); } catch { continue; }
    if (result?.systemPrompt !== undefined) { systemPrompt = result.systemPrompt; options.forceSystemPrompt = systemPrompt; }
  }
  return { sections: options.sections, systemPrompt };
}
const ruleSections = sections => Object.fromEntries(Object.entries(sections).filter(([key]) => key.endsWith('_rules')));

test('the tool-rule sections match the golden, in manifest order, for each active-tool set', async () => {
  const actual = {};
  for (const [name, tools] of Object.entries(SETS)) actual[name] = Object.entries(ruleSections((await sectionsFor(tools)).sections));
  if (process.env.UPDATE_PROMPT_SNAPSHOT === '1') await writeFile(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
  assert.deepEqual(actual, JSON.parse(await readFile(GOLDEN, 'utf8')));
});

test('the rules stay within a token budget with shell, edit, subagent and fork active (the former single section was about 380; the two delegation rules now repeat one sentence)', async () => {
  const all = Object.values(ruleSections((await sectionsFor(['bash', 'edit', 'subagent', 'fork'])).sections)).join('\n\n');
  assert.ok(all.length / 4 < 450, `~${Math.round(all.length / 4)} tokens`);
  for (const name of ['note', 'sqlite', 'monitor_', 'schedule_prompt', 'recall', 'pty_']) assert.ok(!all.includes(name), name);
});

test('a forced system prompt receives each rule section exactly once, in the same order', async () => {
  const { sections, systemPrompt } = await sectionsFor(SETS['shell + file + subagent + fork'], 'FORCED');
  assert.ok(systemPrompt.startsWith('FORCED'));
  const order = Object.keys(ruleSections(sections));
  assert.ok(order.length >= 5, order.join());
  let last = -1;
  for (const key of order) {
    assert.equal(systemPrompt.split(sections[key]).length - 1, 1, `${key} appears once`);
    const at = systemPrompt.indexOf(sections[key]);
    assert.ok(at > last, `${key} follows the previous section`); last = at;
  }
});

test.after(() => rm(home, { recursive: true, force: true }));
