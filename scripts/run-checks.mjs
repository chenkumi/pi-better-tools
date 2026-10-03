import { readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, runNpm } from '../modules/file-tools/scripts/test-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const group = process.argv[2];
const moduleTask = (module, script) => ({ label: `${module}:${script}`, module, script });
// Only file-tools and scheduler keep module manifests (historical test commands). Subagents, shell-tools and web-tools have none,
// so their tests run directly from the root; npm would otherwise walk up and re-run this runner recursively.
const tsx = import.meta.resolve('tsx');
const testFiles = (dir, keep) => readdirSync(join(root, dir)).filter(name => /\.test\.(ts|mjs)$/.test(name) && keep(name)).sort().map(name => `${dir}/${name}`);
const isIntegration = name => name.includes('.integration.');
const directTests = (label, dir, keep, { testConcurrency, ...extra } = {}) => ({ label,
  args: ['--import', tsx, '--test', ...(testConcurrency ? [`--test-concurrency=${testConcurrency}`] : []), ...testFiles(dir, keep)], ...extra });
// Keep disk-heavy 100 MiB stress files from starving the 300 ms fault-injection
// startup gates. This changes file scheduling only: parallel dispatch tests,
// watchdogs, failure assertions and production concurrency remain intact.
const sourceTests = [directTests('subagents:test', 'modules/subagents/tests', name => !isIntegration(name), { testConcurrency: 1 }),
  directTests('shell-tools:test:unit', 'modules/shell-tools/tests', name => !isIntegration(name)),
  moduleTask('file-tools', 'test'), moduleTask('file-tools', 'test:tooling'),
  directTests('web-tools:test', 'modules/web-tools/tests/unit', () => true), moduleTask('scheduler', 'test:unit')];
const groups = {
  build: [moduleTask('scheduler', 'build')],
  typecheck: [...['file-tools', 'scheduler'].map(m => moduleTask(m, 'typecheck')),
    ...['shell-tools', 'web-tools'].map(m => ({ label: `${m}:typecheck`, args: ['node_modules/typescript/bin/tsc', '-p', `modules/${m}/tsconfig.json`] })),
    { label: 'note-tools:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/note-tools/tsconfig.json'] },
    { label: 'gpt-speed:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/gpt-speed/tsconfig.json'] },
    { label: 'goal:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/goal/tsconfig.json'] },
    { label: 'json-schema:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/json-schema/tsconfig.json'] }],
  unit: [...sourceTests, { label: 'note-tools:test', args: ['--import', import.meta.resolve('tsx'), '--test', 'modules/note-tools/tests/note.test.ts'] },
    { label: 'gpt-speed:test', args: ['--import', import.meta.resolve('tsx'), '--test', 'modules/gpt-speed/tests/gpt-speed.test.ts'] },
    { label: 'goal:test', args: ['--import', import.meta.resolve('tsx'), '--test', 'modules/goal/tests/goal.test.ts'] },
    { label: 'json-schema:test', args: ['--import', import.meta.resolve('tsx'), '--test', 'modules/json-schema/tests/schema.test.ts', 'modules/json-schema/tests/extract.test.ts', 'modules/json-schema/tests/delivery.test.ts'] }],
  integration: [directTests('shell-tools:test:integration', 'modules/shell-tools/tests', isIntegration), moduleTask('file-tools', 'test:integration'), moduleTask('scheduler', 'test:integration'),
    directTests('subagents:test:integration', 'modules/subagents/tests', isIntegration),
    { label: 'goal:real-pi-runtime', args: ['--test', 'modules/goal/tests/runtime.test.mjs'] },
    { label: 'json-schema:real-cli', args: ['--test', 'modules/json-schema/tests/runtime.test.mjs'] },
    { label: 'scheduler:source-loader', args: ['--test', 'tests/integration/scheduler-source.test.mjs'] },
    { label: 'all-modules:sdk-hooks', args: ['--test', 'tests/integration/sdk-hooks.test.mjs'] },
    { label: 'all-modules:provenance', args: ['--test', 'tests/integration/provenance.test.mjs'] },
    { label: 'all-modules:integration', args: ['--import', import.meta.resolve('tsx'), '--test', '--test-concurrency=1', 'tests/integration/package.test.mjs'] }],
  browser: [{ label: 'web-tools:real-browser', args: ['--import', import.meta.resolve('tsx'), '--test', 'modules/web-tools/tests/integration/fetch.test.ts'] },
    { label: 'all-modules:web-read', args: ['--import', import.meta.resolve('tsx'), '--test', 'tests/integration/browser.test.mjs'] }],
};
if (!groups[group]) throw new Error(`Unknown check group: ${group}`);
const evidence = join(root, 'plan/evidence');
await mkdir(evidence, { recursive: true });
const results = [];
for (const task of groups[group]) {
  const startedAt = new Date().toISOString();
  try {
    const env = { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
    if (task.label === 'subagents:test:integration') {
      env.PI_SUBAGENTS_TEST_CLI = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle/cli.js');
      env.PI_SUBAGENTS_TEST_EVIDENCE = join(evidence, 'subagents');
    }
    const options = { cwd: task.module ? join(root, 'modules', task.module) : root, env, timeoutMs: 600000 };
    if (task.module) {
      // npm otherwise walks up to the root manifest and may recursively run this runner.
      const manifestPath = join(options.cwd, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!manifest.scripts?.[task.script]) throw new Error(`Missing module script ${task.script}: ${manifestPath}`);
    }
    const output = task.module
      ? await runNpm(task.label, ['run', task.script], options)
      : await runCommand(task.label, process.execPath, task.args, options);
    await writeFile(join(evidence, `${task.label.replaceAll(':', '-')}.log`), output);
    results.push({ label: task.label, status: 'passed', startedAt, endedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error.stack ?? error);
    await writeFile(join(evidence, `${task.label.replaceAll(':', '-')}.log`), String(error.stack ?? error));
    results.push({ label: task.label, status: 'failed', startedAt, endedAt: new Date().toISOString(), error: String(error.message ?? error) });
    process.exitCode = 1;
  }
  await writeFile(join(evidence, `${group}.json`), JSON.stringify({ group, node: process.version, platform: process.platform, results }, null, 2) + '\n');
}
console.log(`[checks] ${group}: ${results.filter(r => r.status === 'passed').length}/${results.length} stages completed successfully. Inspect output for skips.`);
