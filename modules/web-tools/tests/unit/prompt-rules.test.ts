import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWebRules } from '../../src/prompt-rules.ts';

const rules = (...tools: string[]) => renderWebRules(new Set(tools));

test('web rules need a shell and name only the active web tools', () => {
  assert.equal(rules('web_fetch', 'web_search'), undefined);
  assert.equal(rules('bash'), undefined);
  assert.equal(rules('powershell', 'web_search'), '- Use `web_search` for web content, not `curl`/`wget`.');
  assert.match(rules('bash', 'web_fetch', 'web_search')!, /`web_fetch`\/`web_search`/);
});
