import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFileRules } from '../src/prompt-rules.js';

const rules = (...tools: string[]) => renderFileRules(new Set(tools));

test('file rules need a shell: without one there is nothing to prefer over', () => {
  assert.equal(rules('read', 'grep', 'edit', 'write'), undefined);
});

test('inspection tools are named only when active; editing rule needs edit or write', () => {
  assert.equal(rules('bash'), undefined);
  const files = rules('bash', 'read', 'grep')!;
  assert.match(files, /`read`\/`grep`, not shell/); assert.doesNotMatch(files, /`find`|`ls`|Files and shell/);
  assert.match(rules('powershell', 'edit')!, /Files and shell/);
});

test('editing a file from the shell is stated as a rule violation, not just discouraged', () => {
  for (const text of [rules('bash', 'write')!, rules('powershell', 'edit', 'subagent', 'fork')!]) {
    assert.match(text, /never through shell redirection, `sed`, or one-off scripts \(`node -e`, `perl -i`\)/);
    assert.match(text, /is a rule violation/);
    assert.match(text, /Use the shell for builds, tests, git and pipelines/);
  }
});
