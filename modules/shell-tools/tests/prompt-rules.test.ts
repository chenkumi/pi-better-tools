import assert from 'node:assert/strict';
import test from 'node:test';
import { renderShellRules } from '../src/prompt-rules.js';

const rules = (...tools: string[]) => renderShellRules(new Set(tools));

test('shell rules appear only with a shell tool', () => {
  assert.equal(rules('read', 'edit'), undefined);
  assert.match(rules('bash')!, /Verify before claiming/);
});

test('the circumvention rule needs a dedicated tool that could be circumvented', () => {
  assert.doesNotMatch(rules('bash')!, /Never use the shell to get around/);
  for (const tool of ['read', 'grep', 'find', 'ls', 'web_fetch', 'web_search']) assert.match(rules('powershell', tool)!, /Never use the shell to get around what a dedicated tool refuses/, tool);
  assert.doesNotMatch(rules('bash', 'sqlite_query', 'mysql_query')!, /Never use the shell to get around|database/, 'database tool usage rules belong in the AGENTS.md of the user');
});
