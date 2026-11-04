import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderCrossToolRules } from '../../modules/pi-runtime/src/cross-tool-guidance.ts';

// Golden text of the cross-tool prompt section for representative active-tool sets. It pins the exact prompt
// bytes (provider cache prefixes depend on them). A refactoring phase that changes the wording or the split
// must regenerate the golden on purpose: UPDATE_PROMPT_SNAPSHOT=1 node --import tsx --test <this file>.
const GOLDEN = new URL('../fixtures/prompt-snapshot.json', import.meta.url);
const SETS = {
  'read only': ['read'],
  'shell only': ['bash'],
  'shell + file': ['bash', 'read', 'grep', 'find', 'ls', 'edit', 'write'],
  'shell + file + web': ['powershell', 'read', 'grep', 'find', 'ls', 'edit', 'write', 'web_fetch', 'web_search'],
  'shell + file + subagent': ['bash', 'read', 'edit', 'subagent'],
  'shell + file + subagent + fork': ['bash', 'read', 'edit', 'write', 'subagent', 'fork'],
};
const actual = Object.fromEntries(Object.entries(SETS).map(([name, tools]) => [name, renderCrossToolRules(new Set(tools))]));

test('the cross-tool prompt section matches the golden for each active-tool set', () => {
  if (process.env.UPDATE_PROMPT_SNAPSHOT === '1') writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
  assert.deepEqual(actual, JSON.parse(readFileSync(GOLDEN, 'utf8')));
});
