import test from 'node:test';
import assert from 'node:assert/strict';
import monitorExtension from '../src/index.ts';
import type { MonitorRuntime } from '../src/core.ts';
test('Monitor defaults active without starting sources or timers', () => {
  const tools: any[] = [];
  monitorExtension({ registerTool: (tool: any) => tools.push(tool), on() {}, sendMessage() { assert.fail('registration must not send'); } } as any, {
    clock: { now: () => 0, set() { assert.fail('registration must not start timers'); }, clear() {} },
  });
  assert.deepEqual(tools.map(tool => tool.name), ['monitor_start', 'monitor_status', 'monitor_stop']);
  for (const tool of tools) assert.equal(tool.defaultActive, true);
});
test('review S3: saved status definition rejects non-record direct execution before readonly list', async () => {
  const tools = new Map<string, any>(), handlers = new Map<string, any>(); let runtime!: MonitorRuntime, lists = 0;
  monitorExtension({ registerTool: (t: any) => tools.set(t.name, t), on: (name: string, fn: any) => handlers.set(name, fn), getActiveTools: () => ['monitor_status'], sendMessage() {} } as any, { onRuntime: r => { runtime = r; } });
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'strict-status' } };
  await handlers.get('session_start')({}, ctx);
  const list = runtime.list.bind(runtime); runtime.list = (...args) => { lists++; return list(...args); };
  for (const value of [42, true, [], ['x'], 'x', null, undefined, { extra: true }]) {
    const result = await tools.get('monitor_status').execute('direct', value, undefined, undefined, ctx);
    assert.equal(result.isError, true, `reject ${JSON.stringify(value)}`); assert.equal(lists, 0);
  }
  assert.deepEqual((await tools.get('monitor_status').execute('direct', {}, undefined, undefined, ctx)).structuredContent, { monitors: [] }); assert.equal(lists, 1);
  await handlers.get('session_shutdown')({}, ctx);
});
