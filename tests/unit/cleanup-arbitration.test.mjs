import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

const compatUrl = new URL('../../modules/web-tools/scripts/compat.mjs', import.meta.url);
let compatSource = await readFile(compatUrl, 'utf8');
const compatAst = ts.createSourceFile('compat.mjs', compatSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
for (const node of [...compatAst.statements].reverse()) {
  if (ts.isImportDeclaration(node)) compatSource = compatSource.slice(0, node.pos) + compatSource.slice(node.end);
}
compatSource = compatSource.replaceAll('import.meta.url', JSON.stringify(compatUrl.href));

for (const primaryFails of [false, true]) {
  for (const cleanupFails of [false, true]) {
    for (const integrity of ['unchanged', 'changed', 'read-failure']) {
      test(`compat cleanup preserves failures: primary=${primaryFails}, cleanup=${cleanupFails}, integrity=${integrity}`, async () => {
        const primary = new Error('validation failure'), cleanup = new Error('remove failure'), digestFailure = new Error('digest failure');
        const root = resolve(fileURLToPath(new URL('..', compatUrl)));
        const manifests = [join(root, 'package.json'), join(root, 'package-lock.json')];
        let after = false, readsAfter = 0, removed = 0;
        const passes = [];
        const result = await runInNewContext(`(async () => { ${compatSource} })()`, {
          join, resolve, fileURLToPath, tmpdir, createHash, AggregateError, URL,
          process: { argv: ['node', 'compat.mjs', '0.99.1'], platform: 'fixture', version: 'fixture' },
          console: { error() {}, log: message => passes.push(message) },
          mkdtemp: async () => '/isolated-fixture',
          mkdir: async () => { if (primaryFails) throw primary; },
          cp: async () => {}, writeFile: async () => {}, runNpm: async () => {},
          isolatedEnv: () => ({}), existsSync: () => true,
          chromium: { executablePath: () => '/cache/chromium-123/chrome' },
          readFile: async path => {
            if (manifests.includes(path)) {
              if (after) {
                readsAfter++;
                if (integrity === 'read-failure') throw digestFailure;
                if (integrity === 'changed') return 'changed manifest';
              }
              return 'original manifest';
            }
            return JSON.stringify({ version: '0.99.1', devDependencies: {} });
          },
          rm: async (path, options) => {
            assert.equal(path, '/isolated-fixture');
            assert.equal(options.force, true); assert.equal(options.maxRetries, 5); assert.equal(options.retryDelay, 200);
            removed++; after = true;
            if (cleanupFails) throw cleanup;
          },
        }).then(() => ({ failed: false }), error => ({ failed: true, error }));
        assert.equal(removed, 1); assert.equal(readsAfter, 2, 'integrity check must run even after rm failure');
        const expected = [...(primaryFails ? [primary] : []), ...(cleanupFails ? [cleanup] : [])];
        if (integrity !== 'unchanged') expected.push(integrity === 'read-failure' ? digestFailure : 'manifest mismatch');
        assert.equal(result.failed, expected.length > 0);
        assert.equal(passes.length, result.failed ? 0 : 1, 'PASS requires successful validation and cleanup');
        const errors = expected.length > 1 ? result.error.errors : result.failed ? [result.error] : [];
        if (expected.length > 1) assert.ok(result.error instanceof AggregateError);
        for (const [index, error] of expected.entries()) {
          if (error === 'manifest mismatch') assert.match(errors[index].message, /Root package manifests changed/);
          else assert.equal(errors[index], error);
        }
      });
    }
  }
}
