import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile, stat } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import registerSubagent from '../extensions/subagent/index.ts';
import { isolatedEnv } from './fixtures/pi-cli-harness.ts';

test('Pi 1.0.0 ready query answers from committed child history with zero tools and no original writes', { timeout: 90000 }, async () => {
  console.log('[ready-query] Checking real Pi child registry, committed snapshot and read-only answer...');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-ready-query-host-')));
  const previous = { ...process.env };
  const tools = new Map<string, any>(), handlers = new Map<string, Function>(), notifications: any[] = [];
  let queryReported!: () => void;
  const queryResult = new Promise<void>(resolve => { queryReported = resolve; });
  try {
    const env = { ...isolatedEnv(root), PI_BLACKHOLE_PASSIVE: 'true' };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    await mkdir(join(root, 'config'), { recursive: true });
    const provider = fileURLToPath(new URL('./fixtures/rpc-provider.ts', import.meta.url));
    await writeFile(join(root, 'config/settings.json'), JSON.stringify({ extensions: [provider], defaultProjectTrust: 'never', retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false }));
    await writeFile(join(root, 'config/auth.json'), '{}');
    const cli = previous.PI_SUBAGENTS_TEST_CLI ?? join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle/cli.js');
    registerSubagent({ registerTool(t: any) { tools.set(t.name, t); }, registerMessageRenderer() {}, on(name: string, fn: Function) { handlers.set(name, fn); }, sendMessage(message: any) {
      notifications.push(message);
      if (message.details?.kind === 'query_result') queryReported();
    } } as any, { debugLog: false, sessionRootDir: join(root, 'config/subagent-sessions'), invocation: args => ({ command: process.execPath, args: [cli, '--offline', ...args] }) });
    const parent = SessionManager.create(root, join(root, 'parent-sessions'));
    parent.appendMessage({ role: 'user', content: 'Offline ready-query integration', timestamp: Date.now() });
    const model = { provider: 'subagent-test', id: 'fixture', reasoning: false };
    const ctx: any = { cwd: root, mode: 'rpc', hasUI: false, isProjectTrusted: () => false, sessionManager: parent, model, thinkingLevel: 'off', modelRegistry: { find: () => model, getAll: () => [model] } };
    await handlers.get('session_start')!({}, ctx);
    const initial = await tools.get('subagent').execute('create', { agent: 'worker', task: 'prime' }, undefined, undefined, ctx);
    const first = initial.details.results[0];
    assert.equal(first.canResume, true, JSON.stringify(first));
    const directory = join(root, 'config/subagent-sessions', first.subagentSessionId);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const paths = [join(directory, 'manifest.json'), join(directory, manifest.nativeFile), first.logPath];
    const before = await Promise.all(paths.map(path => readFile(path)));
    const runsBefore = await readdir(join(directory, 'runs'));
    const accepted = await tools.get('subagent_message').execute('query', { subagentSessionId: first.subagentSessionId, mode: 'query', message: 'Explain the completed prime task.', title: 'Review finished work' }, undefined, undefined, ctx);
    assert.equal(accepted.isError, undefined, JSON.stringify(accepted.details));
    assert.equal(accepted.details.action, 'query'); assert.equal(accepted.details.status, 'accepted');
    assert.equal(accepted.details.subagentSessionId, first.subagentSessionId); assert.equal(accepted.usage, undefined);
    await queryResult;
    const result = notifications.find(message => message.details?.kind === 'query_result').details.interaction;
    assert.equal(result.queryId, accepted.details.queryId);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.usage.totalTokens, 12);
    assert.equal(result.asOf.sourceLeafId, manifest.checkpoint.leafId);
    const answer = JSON.parse(result.output);
    assert.deepEqual(answer.tools, []);
    assert.ok(answer.users.some((text: string) => text.includes('prime')));
    assert.ok(answer.opaque.includes('opaque-prime'));
    assert.equal(answer.answer, 'offline query answer');
    for (const question of ['fail-query', 'emit-tool', 'stream-tool']) {
      console.log(`[ready-query] Checking isolated failure: ${question}...`);
      const reported = new Promise<void>(resolve => { queryReported = resolve; });
      const submitted = await tools.get('subagent_message').execute(question, { subagentSessionId: first.subagentSessionId, mode: 'query', message: question }, undefined, undefined, ctx);
      assert.equal(submitted.details.status, 'accepted', JSON.stringify(submitted.details));
      await reported;
      const reply = notifications.at(-1).details.interaction;
      assert.equal(reply.queryId, submitted.details.queryId); assert.equal(reply.status, 'failed', JSON.stringify(reply));
      if (question.includes('tool')) assert.match(reply.error, /QUERY_TOOLS_FORBIDDEN/);
      if (question === 'stream-tool') assert.equal(reply.usageUnknown, true);
      await assert.rejects(stat(join(root, 'forbidden-executed')), { code: 'ENOENT' });
      await assert.rejects(stat(join(directory, 'writer.lock')), { code: 'ENOENT' });
      assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
    }
    console.log('[ready-query] Checking concurrent continuation refusal and real provider cancellation...');
    await rm(join(root, 'query-capture.json'));
    let captured!: () => void;
    const capture = new Promise<void>(resolve => { captured = resolve; });
    const watcher = watch(root, () => { if (existsSync(join(root, 'query-capture.json'))) captured(); });
    const cancelled = new Promise<void>(resolve => { queryReported = resolve; });
    try {
      const holding = await tools.get('subagent_message').execute('hold', { subagentSessionId: first.subagentSessionId, mode: 'query', message: 'hold-query' }, undefined, undefined, ctx);
      assert.equal(holding.details.status, 'accepted', JSON.stringify(holding.details));
      await capture;
      for (const mode of ['control', 'query']) {
        const refused = await tools.get('subagent_message').execute(`competing-${mode}`, { subagentSessionId: first.subagentSessionId, mode, message: 'must not execute' }, undefined, undefined, ctx);
        assert.equal(refused.isError, true, 'expected refusal preserves the model-side error flag'); assert.equal(refused.details.status, 'rejected'); assert.equal(refused.details.errorCode, 'SESSION_BUSY');
      }
      const cancellation = await tools.get('subagent_cancel').execute('cancel', { jobId: holding.details.jobId }, undefined, undefined, ctx);
      assert.equal(cancellation.details.cancelRequested, true);
      await cancelled;
      assert.equal(notifications.at(-1).details.interaction.status, 'aborted');
      assert.equal(await readFile(join(root, 'query-aborted'), 'utf8'), 'signal reached provider API');
    } finally { watcher.close(); }
    await handlers.get('session_shutdown')!({}, ctx);
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
    assert.deepEqual(await readdir(join(directory, 'runs')), runsBefore);
    assert.equal(notifications.filter(message => message.details?.kind === 'query_result').length, 5);
    assert.equal(notifications.filter(message => ['task_result', 'log_ready'].includes(message.details?.kind)).length, 0, 'query never announces a resumed main task');
    console.log('[ready-query] Actual guarded query passed; original manifest/native/transcript/runs unchanged.');
  } finally {
    await handlers.get('session_shutdown')?.({}, {});
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});
