import { readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, runNpm } from '../modules/file-tools/scripts/test-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const group = process.argv[2];
const moduleTask = (module, script) => ({ label: `${module}:${script}`, module, script });
// Only file-tools keeps a module manifest (historical test commands). Subagents, shell-tools and web-tools have none,
// so their tests run directly from the root; npm would otherwise walk up and re-run this runner recursively.
const tsx = import.meta.resolve('tsx');
// Heavy tests (measured >= 30 s per file: real Pi host / CLI / browser, multi-process recovery, long timeouts) are excluded from every
// default group and only run by `npm run test:heavy` (see AGENTS.md: needs an explicit user request or a full-suite request).
const heavyFiles = new Set([
  'modules/json-schema/tests/runtime.test.mjs', 'tests/integration/sdk-hooks.test.mjs', 'modules/subagents/tests/child-shell-guard-reload.integration.test.mjs',
  'modules/shell-tools/tests/recovery.integration.test.mjs', 'modules/shell-tools/tests/extension.integration.test.mjs', 'modules/shell-tools/tests/notification-batching.integration.test.mjs',
  'modules/web-tools/tests/integration/fetch.test.ts', 'modules/fork/tests/real-host.integration.test.ts', 'modules/fork/tests/blocked-report.integration.test.ts',
  'modules/file-audit/tests/tui-workflow.integration.test.mjs', 'modules/blackhole/tests/d03-branch-epoch.integration.test.mjs', 'modules/blackhole/tests/d20-settings-non-tui.integration.test.mjs',
  'modules/sql-connector/tests/sdk.integration.test.mjs', 'modules/monitor/tests/host.integration.test.mjs']);
const testFiles = (dir, keep) => readdirSync(join(root, dir)).filter(name => /\.test\.(ts|mjs)$/.test(name) && keep(name) && !heavyFiles.has(`${dir}/${name}`)).sort().map(name => `${dir}/${name}`);
const isIntegration = name => name.includes('.integration.');
// Unit files use isolated temp dirs and separate processes. Subagent fault-injection files stay serial:
// process-global fault mocks and actual resource barriers must not overlap; targeted deadlines start at injected entry.
const directTests = (label, dir, keep, extra = {}) => {
  // An empty list would make `node --test` scan its default directories and silently run something else.
  const files = testFiles(dir, keep);
  if (files.length === 0) throw new Error(`${label}: no test files matched in ${dir}`);
  return { label, args: ['--import', tsx, '--test', `--test-concurrency=${extra.concurrency ?? 1}`, ...files], ...extra };
};
const sourceTests = [directTests('sqlite-tools:test', 'modules/sqlite-tools/tests', name => !isIntegration(name)), directTests('pty-terminal:test', 'modules/pty-terminal/tests', name => !isIntegration(name)), directTests('subagents:test', 'modules/subagents/tests', name => !isIntegration(name)),
  directTests('shell-tools:test:unit', 'modules/shell-tools/tests', name => !isIntegration(name)),
  moduleTask('file-tools', 'test'), moduleTask('file-tools', 'test:tooling'),
  directTests('web-tools:test', 'modules/web-tools/tests/unit', () => true, { concurrency: 4 }),
  // Schedule Prompt keeps its source vitest runner (heavy vi.mock use); modules/schedule-prompt/test is therefore not scanned by node --test.
  { label: 'sql-connector:test', args: ['node_modules/vitest/vitest.mjs', 'run', '--root', 'modules/sql-connector', '--exclude', '**/tests/**'] },
  { label: 'schedule-prompt:test', args: ['node_modules/vitest/vitest.mjs', 'run', '--root', 'modules/schedule-prompt'] },
  { label: 'blackhole:test', args: ['scripts/blackhole-tests.mjs', '--suite=unit'] }];
const groups = {
  // No module ships compiled artifacts any more; the group stays so `npm run build` / prepack remain valid no-ops.
  build: [],
  typecheck: [moduleTask('file-tools', 'typecheck'),
    ...['shell-tools', 'web-tools', 'pty-terminal', 'subagents', 'sqlite-tools', 'sql-connector'].map(m => ({ label: `${m}:typecheck`, args: ['node_modules/typescript/bin/tsc', '-p', `modules/${m}/tsconfig.json`] })),
    { label: 'file-audit:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/file-audit/tsconfig.json'] },
    { label: 'fork:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/fork/tsconfig.json'] },
    { label: 'monitor:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/monitor/tsconfig.json'] },
    { label: 'pi-runtime:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/pi-runtime/tsconfig.json'] },
    { label: 'skill-tools:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/skill-tools/tsconfig.json'] },
    { label: 'note-tools:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/note-tools/tsconfig.json'] },
    { label: 'gpt-speed:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/gpt-speed/tsconfig.json'] },
    { label: 'schedule-prompt:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/schedule-prompt/tsconfig.json'] },
    { label: 'json-schema:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/json-schema/tsconfig.json'] },
    { label: 'blackhole:typecheck', args: ['node_modules/typescript/bin/tsc', '-p', 'modules/blackhole/tsconfig.json'] }],
  // Scan test directories (not hard-coded lists) so a new *.test.ts is never silently skipped; *.test.mjs there are real-host integration tests.
  unit: [directTests('file-audit:test', 'modules/file-audit/tests', name => !isIntegration(name)), directTests('skill-tools:test', 'modules/skill-tools/tests', name => !isIntegration(name)), directTests('all-modules:test-tooling', 'tests/unit', () => true), directTests('monitor:test', 'modules/monitor/tests', name => !isIntegration(name)), directTests('fork:test', 'modules/fork/tests', name => !isIntegration(name)), directTests('pi-runtime:test', 'modules/pi-runtime/tests', name => !isIntegration(name)), ...sourceTests, ...[['note-tools', 'modules/note-tools/tests'], ['gpt-speed', 'modules/gpt-speed/tests'], ['json-schema', 'modules/json-schema/tests']]
    .map(([module, dir]) => directTests(`${module}:test`, dir, name => name.endsWith('.test.ts')))],
  integration: [directTests('file-audit:real-host', 'modules/file-audit/tests', isIntegration), directTests('sqlite-tools:real-host', 'modules/sqlite-tools/tests', isIntegration), directTests('skill-tools:real-host', 'modules/skill-tools/tests', isIntegration), directTests('monitor:integration', 'modules/monitor/tests', isIntegration), directTests('pi-runtime:real-host', 'modules/pi-runtime/tests', isIntegration), directTests('pty-terminal:test:integration', 'modules/pty-terminal/tests', isIntegration),
    directTests('json-schema:workers', 'modules/json-schema/tests', isIntegration),
    // Real-host regressions for reported defects (todo cases document known limits and do not fail the stage).
    directTests('gpt-speed:real-host', 'modules/gpt-speed/tests', isIntegration),
    directTests('note-tools:real-host', 'modules/note-tools/tests', isIntegration),
    directTests('schedule-prompt:integration', 'modules/schedule-prompt/tests', isIntegration, { concurrency: 3 }),
    { label: 'schedule-prompt:real-host', args: ['--test', 'tests/integration/schedule-deadline.test.mjs'] },
    { label: 'blackhole:real-host', args: ['--test', 'tests/integration/blackhole-display.test.mjs'] },
    directTests('blackhole:integration', 'modules/blackhole/tests', isIntegration),
    directTests('shell-tools:test:integration', 'modules/shell-tools/tests', isIntegration), moduleTask('file-tools', 'test:integration'),
    directTests('subagents:test:integration', 'modules/subagents/tests', isIntegration, { concurrency: 3 }),
    { label: 'all-modules:integration', args: ['--import', import.meta.resolve('tsx'), '--test', '--test-concurrency=1', 'tests/integration/package.test.mjs'] }],
  browser: [{ label: 'all-modules:web-read', args: ['--import', import.meta.resolve('tsx'), '--test', 'tests/integration/browser.test.mjs'] }],
};
// Per-module and cross-cutting selection: a task belongs to the module named by its label prefix.
// 'all-modules:web-read' exercises Web Fetch, so it belongs to web-tools; the other all-modules stages are cross-cutting.
const ownerOf = task => task.label === 'all-modules:web-read' ? 'web-tools' : task.label.split(':')[0];
// Heavy group: one task per file, labelled `<module>:heavy:<file>` so `heavy <module>` can narrow it. Not part of any other group.
const heavyTask = file => {
  const module = file.startsWith('modules/') ? file.split('/')[1] : 'all-modules';
  return { label: `${module}:heavy:${file.split('/').pop().replace(/\.test\.(ts|mjs)$/, '')}`, args: ['--import', tsx, '--test', file] };
};
// Non-file heavy commands: the Blackhole upstream Vitest integration suite measured ~600 s (its single-file budget was exhausted), so it gets a larger budget.
// Blackhole's heavy tests form their own group (`heavy-blackhole`), never mixed into `heavy`.
const allHeavyTasks = [...heavyFiles].sort().map(heavyTask);
const heavyTasks = allHeavyTasks.filter(task => ownerOf(task) !== 'blackhole');
const blackholeHeavyTasks = [...allHeavyTasks.filter(task => ownerOf(task) === 'blackhole'), { label: 'blackhole:heavy:native-vitest', args: ['scripts/blackhole-tests.mjs', '--suite=integration'], timeoutMs: 1500000 }];
const allTasks = [...groups.build, ...groups.typecheck, ...groups.unit, ...groups.integration, ...groups.browser];
const modules = [...new Set(allTasks.map(ownerOf))].filter(name => name !== 'all-modules').sort();
const selected = process.argv[3];
if (group === 'module') {
  if (!modules.includes(selected)) throw new Error(`Usage: run-checks.mjs module <${modules.join('|')}>`);
  groups.module = allTasks.filter(task => ownerOf(task) === selected);
} else if (group === 'cross') groups.cross = allTasks.filter(task => ownerOf(task) === 'all-modules');
else if (group === 'heavy') {
  if (selected && !heavyTasks.some(task => ownerOf(task) === selected)) throw new Error(`Usage: run-checks.mjs heavy [${[...new Set(heavyTasks.map(ownerOf))].join('|')}]`);
  groups.heavy = heavyTasks.filter(task => !selected || ownerOf(task) === selected);
}
else if (group === 'heavy-blackhole') groups['heavy-blackhole'] = blackholeHeavyTasks;
const resultName = group === 'module' ? `module-${selected}` : group === 'heavy' && selected ? `heavy-${selected}` : group;
if (!groups[group]) throw new Error(`Unknown check group: ${group}`);
const evidenceScope = process.env.PI_BETTER_TOOLS_EVIDENCE_SCOPE ?? '';
if (!/^[a-zA-Z0-9_-]*$/.test(evidenceScope)) throw new Error('Invalid evidence scope');
const evidence = join(root, 'plan/evidence'); // Preserve the accepted runner-transform anchor.
const outputEvidence = join(evidence, evidenceScope);
await mkdir(outputEvidence, { recursive: true });
const results = [];
for (const task of groups[group]) {
  const startedAt = new Date().toISOString();
  try {
    const env = { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_BLACKHOLE_PASSIVE: 'true' };
    if (task.label === 'subagents:test:integration') {
      env.PI_SUBAGENTS_TEST_CLI = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle/cli.js');
      env.PI_SUBAGENTS_TEST_EVIDENCE = join(outputEvidence, 'subagents');
    }
    const options = { cwd: task.module ? join(root, 'modules', task.module) : root, env, timeoutMs: task.timeoutMs ?? 600000 };
    if (task.module) {
      // npm otherwise walks up to the root manifest and may recursively run this runner.
      const manifestPath = join(options.cwd, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!manifest.scripts?.[task.script]) throw new Error(`Missing module script ${task.script}: ${manifestPath}`);
    }
    const output = task.module
      ? await runNpm(task.label, ['run', task.script], options)
      : await runCommand(task.label, process.execPath, task.args, options);
    await writeFile(join(outputEvidence, `${task.label.replaceAll(':', '-')}.log`), output);
    results.push({ label: task.label, status: 'passed', startedAt, endedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error.stack ?? error);
    await writeFile(join(outputEvidence, `${task.label.replaceAll(':', '-')}.log`), String(error.stack ?? error));
    results.push({ label: task.label, status: 'failed', startedAt, endedAt: new Date().toISOString(), error: String(error.message ?? error) });
    process.exitCode = 1;
  }
  await writeFile(join(outputEvidence, `${resultName}.json`), JSON.stringify({ group: resultName, node: process.version, platform: process.platform, results }, null, 2) + '\n');
}
console.log(`[checks] ${resultName}: ${results.filter(r => r.status === 'passed').length}/${results.length} stages completed successfully. Inspect output for skips.`);
