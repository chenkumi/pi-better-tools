import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ extensions: [provider], packages: [packageRoot], defaultProjectTrust: 'never', defaultTools: ['read', 'write', 'edit', 'bash', ...(process.platform === 'win32' ? ['powershell'] : []), 'integration_probe'], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false }));
  let framingFailure;
  // This probe requests a background continuation: its real parent prompt must persist.
  // --no-session intentionally refuses that admission; never bypass the runtime journal fence.
  const output = await runCommand('real integrated managed child', process.execPath, [join(host, 'dist/bundle/cli.js'), '--mode', 'rpc', '--offline', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--model', 'integration-offline/fixture', '--tools', 'subagent,subagent_message'], {
    cwd, env: { ...isolatedEnv(home), PI_WEB_TOOLS_CONFIG: join(agentDir, 'web-search.json'), PI_BETTER_TOOLS_CHILD_CWD: childCwd }, timeoutMs: 150000, quiet: true,
    // Retain runCommand's output budget, watchdog and process-tree cleanup. Only
    // keep stdin open for the asynchronous followUp, then close at settled evidence.
    spawnProcess(command, args, options) {
      const proc = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      const decoder = new StringDecoder('utf8'); let buffer = '', terminalSeen = false, resumeJob;
      proc.stdout.on('data', chunk => {
        buffer += decoder.write(chunk);
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
          try {
            const event = JSON.parse(line), message = event.message;
            if (event.type === 'message_end' && message?.role === 'toolResult' && message.toolName === 'subagent_message') {
              if (message.isError) terminalSeen = true;
              else resumeJob = message.details?.jobId;
            }
            if (event.type === 'message_end' && message?.customType === 'subagent_background' && message.details?.kind === 'task_result' && message.details.jobId === resumeJob) terminalSeen = true;
            if (event.type === 'agent_settled' && terminalSeen) proc.stdin.end();
          } catch (error) { framingFailure ??= error; proc.stdin.end(); }
        }
      });
      proc.stdin.on('error', error => { framingFailure ??= error; });
      proc.stdin.write(JSON.stringify({ id: 'production-parent-prompt', type: 'prompt', message: 'Offline integration test' }) + '\n');
      return proc;
    },
  });
  if (evidence) await writeFile(evidence, output);
  if (framingFailure) throw framingFailure;
  const events = output.trim().split('\n').map(line => JSON.parse(line));
  const messages = events.filter(e => e.type === 'message_end' && e.message?.role === 'toolResult' && ['subagent', 'subagent_message'].includes(e.message.toolName)).map(e => e.message);
  assert.equal(messages.length, 2, 'actual agent loop must create then send a continuation message');
  for (const message of messages) assert.equal(message.isError, false, JSON.stringify(message.details));
  const parentSessions = await readdir(join(agentDir, 'sessions'), { recursive: true });
  let parentJournalFound = false;
  for (const path of parentSessions.filter(path => path.endsWith('.jsonl'))) {
    const entries = (await readFile(join(agentDir, 'sessions', path), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (entries.some(entry => {
      if (entry.type !== 'message' || entry.message?.role !== 'user') return false;
      const content = entry.message.content;
      const text = typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('');
      return text === 'Offline integration test';
    })) {
      assert.ok(entries.some(entry => entry.type === 'custom' && entry.customType === 'pi-better-tools-background-state'), 'real parent conversation persists background admission evidence');
      parentJournalFound = true;
    }
  }
  assert.ok(parentJournalFound, 'the actual parent prompt is persisted, not a synthetic journal bypass');
  const first = messages[0].details.results[0], accepted = messages[1].details;
  assert.equal(first.status, 'completed'); assert.equal(first.canResume, true, 'packed guard and initial native checkpoint must pass');
  assert.equal(messages[1].toolName, 'subagent_message'); assert.equal(accepted.action, 'resume'); assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.subagentSessionId, first.subagentSessionId); assert.notEqual(accepted.taskId, first.taskId);
  assert.equal(messages[1].usage, undefined, 'background continuation does not double-count host usage');
  const notices = events.filter(e => e.type === 'message_end' && e.message?.customType === 'subagent_background' && e.message.details?.kind === 'task_result' && e.message.details.jobId === accepted.jobId);
  assert.equal(notices.length, 1, 'accepted packed resume produces exactly one matching terminal followUp');
  const completion = notices[0].message.details; assert.equal(completion.status, 'completed');
  assert.equal(completion.tasks[0].taskId, accepted.taskId);
  const result = completion.tasks[0].result;
  assert.equal(result.status, 'completed'); assert.equal(result.canResume, true, 'packed continuation guard and native checkpoint must pass');
  assert.equal(result.subagentSessionId, first.subagentSessionId); assert.notEqual(result.taskId, first.taskId); assert.equal(result.logPath, first.logPath);
  const directory = join(agentDir, 'subagent-sessions', result.subagentSessionId);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.state, 'ready'); assert.equal((await readdir(join(directory, 'runs'))).length, 2);
  await assert.rejects(stat(join(directory, 'writer.lock')), { code: 'ENOENT' });
  await assert.rejects(stat(join(agentDir, 'sub-sessions')), { code: 'ENOENT' });
  const data = JSON.parse(result.output); assert.equal(data.nativeResume, true); assert.equal(data.userTurns, 2);
  assert.equal(data.noRecursiveSubagent, true); assert.equal(data.nestedFileAndShell, true); assert.equal(data.cwd, childCwd);
  assert.equal(await readFile(join(childCwd, 'child.txt'), 'utf8'), 'child BETA\n');
  console.log('[child] Create plus session-addressed asynchronous native resume, terminal followUp, guard, different cwd, shared package discovery and nested File/Shell passed.');
  return JSON.stringify({ managedReady: result.canResume, guardAccepted: true, differentCwd: true, ...data });
}
