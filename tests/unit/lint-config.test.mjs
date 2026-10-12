import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const cwd = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd });

test('lint parses JS and TS and rejects actual syntax errors', async () => {
  for (const [filePath, source] of [
    ['scripts/lint-probe.mjs', 'export const value = 1;'],
    ['modules/blackhole/src/lint-probe.ts', 'export const value: number = 1;'],
  ]) {
    const [result] = await eslint.lintText(source, { filePath });
    assert.equal(result.errorCount, 0);
  }
  const [invalid] = await eslint.lintText('export const = ;', { filePath: 'scripts/lint-probe.mjs' });
  assert.equal(invalid.fatalErrorCount, 1);
});

test('lint correctness rules detect invalid code without changing source', async () => {
  for (const [rule, source] of [
    ['no-debugger', 'debugger;'],
    ['no-dupe-else-if', 'if (x) {} else if (x) {}'],
    ['no-unsafe-finally', 'function f() { try {} finally { return 1; } }'],
    ['use-isnan', 'if (x === NaN) {}'],
    ['valid-typeof', 'if (typeof x === "strnig") {}'],
  ]) {
    const [result] = await eslint.lintText(source, { filePath: 'tests/unit/lint-probe.mjs' });
    assert.ok(result.messages.some(message => message.ruleId === rule), rule);
    assert.equal(result.output, undefined);
  }
});

test('lint ignores dependencies, artifacts and notes, but includes module tests', async () => {
  for (const path of ['node_modules/probe.ts', 'modules/blackhole/plan/probe.ts', 'plan/evidence/probe.mjs', '.pi/probe.ts', 'dist/probe.ts']) {
    assert.equal(await eslint.isPathIgnored(path), true, path);
  }
  for (const path of ['modules/blackhole/src/index.ts', 'modules/blackhole/tests/rereview-ui-migration.test.ts', 'modules/schedule-prompt/test/deadline.test.ts', 'tests/unit/lint-config.test.mjs']) {
    assert.equal(await eslint.isPathIgnored(path), false, path);
  }
});

test('cleanup implementations pass lint with no-unsafe-finally still enabled', async () => {
  const paths = [
    'modules/subagents/extensions/subagent/index.ts',
    'modules/subagents/extensions/subagent/session-store.ts',
    'modules/web-tools/scripts/compat.mjs',
    'tests/fixtures/sdk-hooks.mjs',
  ];
  for (const path of paths) {
    const config = await eslint.calculateConfigForFile(path);
    assert.equal(config.rules['no-unsafe-finally'][0], 2, path);
  }
  for (const result of await eslint.lintFiles(paths)) {
    assert.deepEqual(result.messages, [], result.filePath);
  }
});

test('upstream TypeScript rule directives resolve without enabling type-aware lint', async () => {
  const [result] = await eslint.lintText('/* eslint-disable @typescript-eslint/no-misused-promises */\nexport const value: number = 1;', { filePath: 'modules/blackhole/src/lint-probe.ts' });
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 0);
});
