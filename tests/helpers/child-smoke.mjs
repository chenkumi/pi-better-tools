import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, copyFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../modules/file-tools/scripts/test-process.mjs';
import { isolatedEnv } from './environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function runChildSmoke({ home, host, packageRoot, evidence }) {
  const agentDir = join(home, '.pi/agent'), cwd = join(home, 'parent'), childCwd = join(home, 'different-child-cwd');
  await Promise.all([agentDir, cwd, childCwd].map(path => mkdir(path, { recursive: true })));
  // Place the standalone provider beside the production host's node_modules, not this development tree.
  const provider = join(dirname(dirname(dirname(host))), 'child-provider.ts');
  await copyFile(join(root, 'tests/fixtures/child-provider.ts'), provider);
  await writeFile(join(agentDir, 'auth.json'), '{}'); await writeFile(join(agentDir, 'web-search.json'), '{"provider":"openai"}');
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ extensions: [provider], packages: [packageRoot], defaultProjectTrust: 'never', defaultTools: ['read', 'write', 'edit', 'bash', ...(process.platform === 'win32' ? ['powershell'] : []), 'integration_probe', 'schedule_status'], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false }));
  const output = await runCommand('real integrated managed child', process.execPath, [join(host, 'dist/bundle/cli.js'), '--mode', 'json', '-p', '--no-session', '--offline', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--model', 'integration-offline/fixture', '--tools', 'subagent', 'Offline integration test'],
    { cwd, env: { ...isolatedEnv(home), PI_WEB_TOOLS_CONFIG: join(agentDir, 'web-search.json'), PI_BETTER_TOOLS_CHILD_CWD: childCwd }, timeoutMs: 150000, quiet: true });
  if (evidence) await writeFile(evidence, output);
  const events = output.trim().split('\n').map(line => JSON.parse(line));
  const messages = events.filter(e => e.type === 'message_end' && e.message?.role === 'toolResult' && e.message.toolName === 'subagent').map(e => e.message);
  assert.equal(messages.length, 2, 'actual agent loop must create then resume');
  for (const message of messages) { assert.equal(message.isError, false, JSON.stringify(message.details)); assert.equal(message.details.results[0].status, 'completed'); assert.equal(message.details.results[0].canResume, true, 'packed guard and native checkpoint must pass'); }
  const first = messages[0].details.results[0], result = messages[1].details.results[0];
  assert.equal(result.subagentSessionId, first.subagentSessionId); assert.notEqual(result.taskId, first.taskId); assert.equal(result.logPath, first.logPath);
  const directory = join(agentDir, 'subagent-sessions', result.subagentSessionId);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.state, 'ready'); assert.equal((await readdir(join(directory, 'runs'))).length, 2);
  await assert.rejects(stat(join(directory, 'writer.lock')), { code: 'ENOENT' });
  await assert.rejects(stat(join(agentDir, 'sub-sessions')), { code: 'ENOENT' });
  const data = JSON.parse(result.output); assert.equal(data.nativeResume, true); assert.equal(data.userTurns, 2);
  assert.equal(data.noRecursiveSubagent, true); assert.equal(data.nestedFileAndShell, true); assert.equal(data.cwd, childCwd);
  assert.equal(await readFile(join(childCwd, 'child.txt'), 'utf8'), 'child BETA\n');
  console.log(`[child] Automatic persistence and actual native resume, guard, different cwd, shared package discovery and nested File/Shell passed; Scheduler role=${data.schedulerRole}.`);
  return JSON.stringify({ managedReady: result.canResume, guardAccepted: true, differentCwd: true, ...data });
}
