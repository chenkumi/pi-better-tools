// D04: a scheduled in-process child session that bound extensions (job.extensions=true) must receive session_shutdown
// before/when it is disposed, so its extensions can clean up.
// Level: real Pi 1.1.0 CLI (rpc); real tool adds a `once` model job with extensions:true; the real scheduler runs the real
// child session, which discovers the probe extension from the global agentDir. The probe counts session_start/session_shutdown per session id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installGlobalExtensions, log, makeSandbox, probePath, providerFile, readJsonl, readStore, scheduleEntry, startPi, toolCall, waitUntil } from './_harness.mjs';

test('D04: child session with extensions emits session_shutdown after the run', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('sp-d04');
  try {
    await installGlobalExtensions(sb, [probePath, providerFile]);
    const pi = startPi(sb, { label: 'D04', approve: true, extensions: [probePath, scheduleEntry], script: [
      { content: [toolCall('schedule_prompt', { action: 'add', name: 'ext-child', type: 'once', schedule: '+1s', prompt: 'child task', model: 'repro-offline/fixture', extensions: true }, 'c1')] },
      { content: [{ type: 'text', text: 'scheduled' }] },
      { content: [{ type: 'text', text: 'child finished normally' }] },
    ] });
    await pi.send({ id: 'p1', type: 'prompt', message: 'Schedule the child job.' });
    assert.ok(await pi.waitFor(e => e.type === 'agent_end', 60000, 'parent agent_end'), 'parent turn must finish (harness sanity)');
    const terminal = await waitUntil(async () => {
      const j = (await readStore(sb)).jobs.find(x => x.name === 'ext-child');
      return j && j.lastStatus && j.lastStatus !== 'running' ? j : undefined;
    }, 40000, 'child run terminal status');
    const parentStart = (await waitUntil(async () => (await readJsonl(pi.paths.events)).find(e => e.type === 'start'), 10000, 'parent session_start probe event'));
    // Give the child a bounded window to emit session_shutdown (a correct implementation emits it at or before the terminal status).
    const childShutdown = await waitUntil(async () => (await readJsonl(pi.paths.events)).find(e => e.type === 'shutdown' && e.sessionId !== parentStart.sessionId), 5000, 'child session_shutdown');
    const events = await readJsonl(pi.paths.events);
    await pi.finish();
    const childStarts = events.filter(e => e.type === 'start' && e.sessionId !== parentStart.sessionId);
    const childShutdowns = events.filter(e => e.type === 'shutdown' && e.sessionId !== parentStart.sessionId);
    log(`terminal=${terminal?.lastStatus}; child starts=${childStarts.length} child shutdowns=${childShutdowns.length}`);
    assert.equal(terminal?.lastStatus, 'success', 'precondition: child run completed');
    assert.ok(childStarts.length >= 1, 'precondition: child session bound extensions (session_start observed)');
    assert.ok(childShutdown && childShutdowns.length >= childStarts.length, 'every child session that started must receive session_shutdown before being disposed');
  } finally { await sb.cleanup(); }
});
