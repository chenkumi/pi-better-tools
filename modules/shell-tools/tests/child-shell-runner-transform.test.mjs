import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RUNNER_REWRITE_TARGETS, transformModuleRunner } from './helpers/child-shell-runner-transform.mjs';

const options = { root: '/isolated/root', processImportURL: 'file:///isolated/process.mjs', tsxURL: 'file:///isolated/tsx.mjs', piURL: 'file:///isolated/pi.js', evidenceRelative: 'plan/evidence/child-shell-review-unit' };
const selection = "const groups = { module: allTasks.filter(task => ownerOf(task) === selected) };\nfor (const task of groups[group]) { await runCommand(task.label, process.execPath, task.args, options); }\nprocess.exitCode = 1;";
const synthetic = RUNNER_REWRITE_TARGETS.flatMap(target => Array(target.count).fill(target.text)).join('\n') + '\n' + selection;

test('evidence rewrites preserve all task selection/assertion/error content', () => {
  const transformed = transformModuleRunner(synthetic, options);
  assert.equal(transformed.slice(transformed.indexOf('const groups')), selection);
  assert.match(transformed, /child-shell-review-unit/);
  assert.ok(!transformed.includes("join(root, 'plan/evidence')"));
  const actual = readFileSync(new URL('../../../scripts/run-checks.mjs', import.meta.url), 'utf8');
  const result = transformModuleRunner(actual, options);
  const start = actual.indexOf('const group ='), end = actual.indexOf('const evidence =');
  let unchanged = actual.slice(start, end);
  for (const [target, replacement] of [["import.meta.resolve('tsx')", JSON.stringify(options.tsxURL)], ["import.meta.resolve('@earendil-works/pi-coding-agent')", JSON.stringify(options.piURL)]]) unchanged = unchanged.replaceAll(target, replacement);
  assert.equal(result.slice(result.indexOf('const group ='), result.indexOf('const evidence =')), unchanged);
});
for (const target of RUNNER_REWRITE_TARGETS) {
  test(`missing ${target.key} rewrite fails before execution`, () => {
    assert.throws(() => transformModuleRunner(synthetic.replace(target.text, 'RUNNER_CHANGED'), options), /Root module runner changed/);
  });
  test(`extra ${target.key} rewrite fails before execution`, () => {
    assert.throws(() => transformModuleRunner(synthetic + '\n' + target.text, options), /Root module runner changed/);
  });
}
