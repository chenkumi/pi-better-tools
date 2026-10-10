// D10: in RPC mode (no TUI components: ui.custom returns undefined, component widgets are ignored)
//  (a) no component-widget refresh timer should be created, and
//  (b) choosing "Jobs" in /schedule-prompt must not be a silent no-op.
// Level: real Pi 1.1.0 CLI in --mode rpc (the host's real RPC UI context), real extension runner and real extension.
// Timer creation is observed with a probe extension that wraps setInterval in the same process (stack must come from cron-widget).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { job, log, makeSandbox, probePath, readJsonl, scheduleEntry, startPi, writeStore } from './_harness.mjs';

async function runRpc() {
  const sb = await makeSandbox('sp-d10');
  await writeStore(sb, [job({ id: 'visible-job', name: 'visible', type: 'interval', schedule: '1h', intervalMs: 3600000, prompt: 'hourly' })]);
  const pi = startPi(sb, { label: 'D10', approve: true, extensions: [probePath, scheduleEntry], script: [] });
  await pi.send({ id: 'ready', type: 'get_state' });
  assert.ok(await pi.waitFor(e => e.type === 'response' && e.id === 'ready', 30000, 'rpc ready'), 'host must be up (harness sanity)');
  const timers = await readJsonl(pi.paths.timers);
  await pi.send({ id: 'cmd', type: 'prompt', message: '/schedule-prompt' });
  const menu = await pi.waitFor(e => e.type === 'extension_ui_request' && e.method === 'select' && /Scheduled Prompts/.test(e.title), 30000, '/schedule-prompt main menu');
  assert.ok(menu, 'precondition: the command opened its select menu over the RPC UI protocol');
  const before = pi.events.length;
  await pi.send({ type: 'extension_ui_response', id: menu.id, value: 'Jobs' });
  // Barrier on the observable effect: the follow-up dialog request (bounded wait; a silent no-op never produces one).
  await pi.waitFor(e => e.type === 'extension_ui_request' && e.id !== menu.id && e.method !== 'notify', 15000, 'dialog after choosing Jobs');
  const after = pi.events.slice(before).filter(e => e.type === 'extension_ui_request' && e.id !== undefined);
  const jobsDialog = after.find(e => e.method === 'select');
  await pi.finish();
  await sb.cleanup();
  const widgetTimers = timers.filter(t => t.widgetTimer);
  log(`widget timers at startup=${JSON.stringify(widgetTimers)}; ui requests after choosing Jobs=${JSON.stringify(after.map(e => e.method))}`);
  return { widgetTimers, after, jobsDialog };
}

test('D10a: RPC mode must not create the component-widget refresh timer', { timeout: 120000 }, async () => {
  const r = await runRpc();
  assert.equal(r.widgetTimers.length, 0, 'CronWidget created a setInterval(30000) although RPC cannot render component widgets');
});

test('D10b: RPC mode: choosing "Jobs" must give visible feedback or a supported alternative, not silently do nothing', { timeout: 120000 }, async () => {
  const r = await runRpc();
  assert.ok(r.jobsDialog && /Jobs/.test(r.jobsDialog.title) && r.jobsDialog.options.some(o => /visible/.test(o)), 'the dialog-based Jobs menu must list the job over the RPC select protocol');
  assert.ok(r.after.length > 0, 'after choosing Jobs, ctx.ui.custom() returned undefined and the command produced no RPC UI request at all (silent no-op)');
});
