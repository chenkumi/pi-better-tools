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
// Unit files use isolated temp dirs and run in separate processes; integration groups stay serial (real Pi hosts, ports, shells).
const directTests = (label, dir, keep, extra = {}) => ({ label, args: ['--import', tsx, '--test', `--test-concurrency=${extra.concurrency ?? 1}`, ...testFiles(dir, keep)], ...extra });
const sourceTests = [directTests('pty-terminal:test', 'modules/pty-terminal/tests', () => true), directTests('subagents:test', 'modules/subagents/tests', name => !isIntegration(name), { concurrency: 4 }),
  directTests('shell-tools:test:unit', 'modules/shell-tools/tests', name => !isIntegration(name)),
  moduleTask('file-tools', 'test'), moduleTask('file-tools', 'test:tooling'),
  directTests('web-tools:test', 'modules/web-tools/tests/unit', () => true, { concurrency: 4 }), moduleTask('scheduler', 'test:unit')];
const groups = {
  build: [moduleTask('scheduler', 'build')],
  typecheck: [...['file-tools', 'scheduler'].map(m => moduleTask(m, 'typecheck')),
    ...['shell-tools', 'web-tools', 'pty-terminal'].map(m => ({ label: `${m}:typecheck`, args: ['node_modules/typescript/bin/tsc', '-p', `modules/${m}/tsconfig.json`] })),
    { label: 'note-tools:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/note-tools/tsconfig.json'] },
    { label: 'gpt-speed:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/gpt-speed/tsconfig.json'] },
    { label: 'goal:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/goal/tsconfig.json'] },
    { label: 'json-schema:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/json-schema/tsconfig.json'] }],
  // Scan test directories (not hard-coded lists) so a new *.test.ts is never silently skipped; *.test.mjs there are real-host integration tests.
  unit: [...sourceTests, ...[['note-tools', 'modules/note-tools/tests'], ['gpt-speed', 'modules/gpt-speed/tests'], ['goal', 'modules/goal/tests'], ['json-schema', 'modules/json-schema/tests']]
    .map(([module, dir]) => directTests(`${module}:test`, dir, name => name.endsWith('.test.ts')))],
  integration: [directTests('shell-tools:test:integration', 'modules/shell-tools/tests', isIntegration), moduleTask('file-tools', 'test:integration'), moduleTask('scheduler', 'test:integration'),
    directTests('subagents:test:integration', 'modules/subagents/tests', isIntegration, { concurrency: 3 }),
    { label: 'goal:real-pi-runtime', args: ['--test', 'modules/goal/tests/runtime.test.mjs'] },
    { label: 'json-schema:real-cli', args: ['--test', 'modules/json-schema/tests/runtime.test.mjs'] },
    { label: 'scheduler:source-loader', args: ['--test', 'tests/integration/scheduler-source.test.mjs'] },
    { label: 'all-modules:sdk-hooks', args: ['--test', 'tests/integration/sdk-hooks.test.mjs'] },
    { label: 'all-modules:provenance', args: ['--test', 'tests/integration/provenance.test.mjs'] },
    { label: 'all-modules:integration', args: ['--import', import.meta.resolve('tsx'), '--test', '--test-concurrency=1', 'tests/integration/package.test.mjs'] }],
  browser: [{ label: 'web-tools:real-browser', args: ['--import', import.meta.resolve('tsx'), '--test', 'modules/web-tools/tests/integration/fetch.test.ts'] },
    { label: 'all-modules:web-read', args: ['--import', import.meta.resolve('tsx'), '--test', 'tests/integration/browser.test.mjs'] }],
};
// Per-module and cross-cutting selection: a task belongs to the module named by its label prefix.
// 'all-modules:web-read' exercises Web Fetch, so it belongs to web-tools; the other all-modules stages are cross-cutting.
const ownerOf = task => task.label === 'all-modules:web-read' ? 'web-tools' : task.label.split(':')[0];
const allTasks = [...groups.build, ...groups.typecheck, ...groups.unit, ...groups.integration, ...groups.browser];
const modules = [...new Set(allTasks.map(ownerOf))].filter(name => name !== 'all-modules').sort();
const selected = process.argv[3];
if (group === 'module') {
  if (!modules.includes(selected)) throw new Error(`Usage: run-checks.mjs module <${modules.join('|')}>`);
  groups.module = allTasks.filter(task => ownerOf(task) === selected);
} else if (group === 'cross') groups.cross = allTasks.filter(task => ownerOf(task) === 'all-modules');
const resultName = group === 'module' ? `module-${selected}` : group;
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
  await writeFile(join(evidence, `${resultName}.json`), JSON.stringify({ group: resultName, node: process.version, platform: process.platform, results }, null, 2) + '\n');
}
console.log(`[checks] ${resultName}: ${results.filter(r => r.status === 'passed').length}/${results.length} stages completed successfully. Inspect output for skips.`);
