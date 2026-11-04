import assert from 'node:assert/strict';
import test from 'node:test';
import * as contracts from '../../src/contracts/index.ts';

test('tool-name constants are valid, unique and do not overlap between groups', () => {
  const groups = Object.entries(contracts).filter(([, v]) => Array.isArray(v)) as [string, readonly string[]][];
  const seen = new Map<string, string>();
  for (const [group, names] of groups) {
    for (const name of names) {
      assert.match(name, /^[a-z][a-z0-9_]*$/, `${group}.${name}`);
      assert.equal(seen.get(name), undefined, `${name} appears in ${group} and ${seen.get(name)}`);
      seen.set(name, group);
    }
  }
  assert.match(contracts.PROGRESS_CHECKPOINT_TOOL, /^[a-z][a-z0-9_]*$/);
});
