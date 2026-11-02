import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the actual script/function bodies with inert dependencies: no CLI,
// legacy host installation, browser launch, credentials or filesystem mutation.
const sdkSource = await readFile(new URL('../fixtures/sdk-hooks.mjs', import.meta.url), 'utf8');
const sdkAst = ts.createSourceFile('sdk-hooks.mjs', sdkSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const checkNode = sdkAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'check');
assert.ok(checkNode);
const checkSource = sdkSource.slice(checkNode.getStart(sdkAst), checkNode.end);
const quiet = { log() {}, error() {} };

for (const primary of [new Error('assertion failure'), undefined, null, false, 0]) {
  for (const actionFails of [false, true]) {
    for (const closeFails of [false, true]) {
      test(`SDK check preserves error identity and waits for close: primary=${String(primary)}, action=${actionFails}, close=${closeFails}`, async () => {
        const cleanup = new Error('close failure'), cases = [], events = [];
        const check = runInNewContext(`(${checkSource})`, {
          console: quiet, expectedVersion: 'fixture', AggregateError, cases,
          fixture: async () => ({ close: async () => { events.push('close'); if (closeFails) throw cleanup; } }),
        });
        const result = await check('case', {}, async () => { events.push('action'); if (actionFails) throw primary; })
          .then(() => ({ failed: false }), error => ({ failed: true, error }));
        assert.deepEqual(events, ['action', 'close']);
        assert.equal(result.failed, actionFails || closeFails);
        assert.equal(cases.length, result.failed ? 0 : 1);
        if (actionFails && closeFails) {
          assert.ok(result.error instanceof AggregateError);
          assert.deepEqual(result.error.errors, [primary, cleanup]);
        } else if (result.failed) assert.equal(result.error, closeFails ? cleanup : primary);
      });
    }
  }
}
