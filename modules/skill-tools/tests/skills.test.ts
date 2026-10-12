import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import skillTools from '../src/index.ts';

test('factory only registers resource discovery; startup and reload use packaged skill paths', () => {
  const handlers: Array<{ event: string; handler: (...args: any[]) => any }> = [];
  skillTools({ on: (event: string, handler: (...args: any[]) => any) => {
    handlers.push({ event, handler });
    return () => {};
  } } as unknown as ExtensionAPI);
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].event, 'resources_discover');
  const expected = fileURLToPath(new URL('../skills/', import.meta.url));
  for (const reason of ['startup', 'reload']) {
    const result = handlers[0].handler({ type: 'resources_discover', reason, cwd: '/unrelated-workspace' });
    assert.deepEqual(result, { skillPaths: [expected] });
    result.skillPaths.push('changed-by-consumer');
    assert.deepEqual(handlers[0].handler(), { skillPaths: [expected] }, 'results do not share mutable arrays');
  }
});
