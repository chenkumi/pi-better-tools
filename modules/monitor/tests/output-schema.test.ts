// Codemode contract: each Monitor tool declares a concrete outputSchema and every structuredContent it returns validates against it.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import monitorExtension from '../src/index.ts';
import type { Clock, MonitorRuntime } from '../src/core.ts';

test('monitor_start, monitor_status (list and one) and monitor_stop structuredContent validates against outputSchema', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-out-'))); writeFileSync(join(root, 'a.txt'), 'x');
  const tools = new Map<string, any>(), handlers = new Map<string, any>(); let runtime!: MonitorRuntime;
  const clock: Clock = { now: () => 0, set: () => 1, clear() {} };
  monitorExtension({ registerMessageRenderer() {}, registerTool: (t: any) => tools.set(t.name, t), on: (name: string, fn: any) => handlers.set(name, fn), getActiveTools: () => ['monitor_start', 'monitor_status', 'monitor_stop'], sendMessage() {} } as any, { clock, onRuntime: r => { runtime = r; } });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'output-schema' } };
  const call = (name: string, params: unknown) => tools.get(name).execute('direct', params, undefined, undefined, ctx);
  const valid = (name: string, result: any) => {
    const schema = tools.get(name).outputSchema;
    assert.equal(Check(schema, result.structuredContent), true, `${name}: ${JSON.stringify(result.structuredContent)}`);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${name}: text and structuredContent carry the same data`);
  };
  try {
    for (const name of ['monitor_start', 'monitor_status', 'monitor_stop']) assert.ok(tools.get(name).outputSchema && Object.keys(tools.get(name).outputSchema).length > 0, name);
    await handlers.get('session_start')({}, ctx);
    valid('monitor_status', await call('monitor_status', {})); // empty list
    const started = await call('monitor_start', { source: { kind: 'file', path: 'a.txt' }, wakeAgent: false });
    assert.equal(started.isError, undefined); valid('monitor_start', started);
    const id = started.structuredContent.monitorId as string;
    valid('monitor_status', await call('monitor_status', {}));
    valid('monitor_status', await call('monitor_status', { monitorId: id }));
    const stopped = await call('monitor_stop', { monitorId: id });
    assert.equal(stopped.isError, undefined); valid('monitor_stop', stopped);
    await runtime.settled(id);
    valid('monitor_status', await call('monitor_status', { monitorId: id })); // terminal receipt
    // In-band rejection shape is part of the schema too.
    const rejected = await call('monitor_stop', { monitorId: 'NOSUCH' });
    assert.equal(rejected.isError, true); valid('monitor_stop', rejected);
  } finally { await handlers.get('session_shutdown')({}, ctx); rmSync(root, { recursive: true, force: true }); }
});
