// D11: shell command jobs (local adaptation) against the real Pi 1.2.0 CLI (rpc), real extension runner, real scheduler,
// the real Pi shell backend (execMonitorCommand) and real child processes. Offline scripted provider; isolated home/workspace.
//   a. trusted project: a once command job runs in its directory, records success and persists a command_done marker;
//   b. untrusted project: the same job file must not run anything;
//   c. output-stall timeout: a silent command is stopped for real, the error says so, and the process is gone;
//   d. the schedule_prompt tool creates a command job only after an explicit UI confirmation (declined: nothing saved).
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { job, log, makeSandbox, readStore, scheduleEntry, startPi, textOf, toolCall, toolResults, waitUntil, writeStore } from './_harness.mjs';

const exists = path => readFile(path, 'utf8').then(() => true, () => false);
/** Windows reports the same directory through its 8.3 short name in this process but through the long name
 *  from a child shell, so identity decides membership; a zero inode cannot prove anything and never passes. */
const sameDirectory = (a, b) => {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const x = statSync(a, { bigint: true }), y = statSync(b, { bigint: true });
  return x.ino !== 0n && x.dev === y.dev && x.ino === y.ino;
};
const aliveProcess = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Scheduler markers as the RPC client saw them (a session file only exists once an assistant turn happened). */
const markers = pi => pi.events.filter(e => e.type === 'message_end' && e.message?.customType === 'scheduled_prompt').map(e => e.message.details);
const soon = ms => new Date(Date.now() + ms).toISOString();
const idle = Array.from({ length: 4 }, () => ({ content: [{ type: 'text', text: 'ok' }] }));
// Same text for PowerShell (Windows default shell) and bash: one double-quoted node script with single quotes inside.
const writeCwd = 'node -e "require(\'fs\').writeFileSync(\'marker.txt\', process.cwd()); console.log(\'D11_OK\')"';

test('D11a: trusted project: a once command job runs in its directory through the real shell backend', { timeout: 150000 }, async () => {
  const sb = await makeSandbox('sp-d11a');
  try {
    const work = join(sb.cwd, 'work');
    await mkdir(work, { recursive: true });
    await writeStore(sb, [job({ id: 'cmd-a', name: 'cmd-a', type: 'once', schedule: soon(3000), intervalMs: undefined, prompt: undefined, command: writeCwd, cwd: work })]);
    const pi = startPi(sb, { label: 'D11a', approve: true, extensions: [scheduleEntry], script: idle });
    await pi.send({ id: 'state', type: 'get_state' });
    assert.ok(await pi.waitFor(e => e.type === 'response' && e.id === 'state', 30000, 'rpc ready'), 'host must be up (harness sanity)');
    const done = await waitUntil(async () => (await readStore(sb)).jobs.find(j => j.id === 'cmd-a')?.lastStatus === 'success', 90000, 'command job success');
    assert.ok(done, `the command job must have run; store=${JSON.stringify((await readStore(sb)).jobs)}`);
    // Read before finish(): closing the session removes disabled (finished once) jobs from the store.
    const stored = (await readStore(sb)).jobs.find(j => j.id === 'cmd-a');
    const seen = markers(pi);
    await pi.finish();
    assert.equal(stored.runCount, 1);
    assert.equal(stored.enabled, false, 'once job is disabled after it ran');
    const reported = (await readFile(join(work, 'marker.txt'), 'utf8')).trim();
    assert.ok(sameDirectory(reported, realpathSync(work)), 'the command must run in the job directory, not the project root');
    log(`markers=${JSON.stringify(seen.map(m => m.mode))}`);
    assert.deepEqual(seen.map(m => m.mode), ['command_start', 'command_done']);
    assert.equal(seen[1].exitCode, 0);
    assert.match(seen[1].output, /D11_OK/);
    assert.equal(pi.badLines.length, 0, `stdout must stay protocol-clean: ${pi.badLines.join('|')}`);
  } finally { await sb.cleanup(); }
});

test('D11b: untrusted project: a command job from the project store must not run', { timeout: 120000 }, async () => {
  const sb = await makeSandbox('sp-d11b');
  try {
    await writeStore(sb, [job({ id: 'cmd-b', name: 'cmd-b', prompt: undefined, command: writeCwd })]);
    const pi = startPi(sb, { label: 'D11b', approve: false, extensions: [scheduleEntry], script: idle });
    await pi.send({ id: 'state', type: 'get_state' });
    assert.ok(await pi.waitFor(e => e.type === 'response' && e.id === 'state', 30000, 'rpc ready'), 'host must be up (harness sanity)');
    // Bounded observation window (1s interval job): ends early as soon as any activity shows up, which is the defect.
    const activity = await waitUntil(async () => (await exists(join(sb.cwd, 'marker.txt'))) || (await readStore(sb)).jobs.some(j => j.lastStatus), 7000, 'any command activity in untrusted project');
    await pi.finish();
    assert.ok(!activity, 'a command job from an untrusted project must not start');
    assert.equal(await exists(join(sb.cwd, 'marker.txt')), false);
  } finally { await sb.cleanup(); }
});

test('D11c: a silent command is stopped at the output-stall deadline and its process is gone', { timeout: 150000 }, async () => {
  const sb = await makeSandbox('sp-d11c');
  try {
    const silent = 'node -e "require(\'fs\').writeFileSync(\'pid.txt\', String(process.pid)); setTimeout(() => {}, 120000)"';
    await writeStore(sb, [job({ id: 'cmd-c', name: 'cmd-c', type: 'once', schedule: soon(3000), intervalMs: undefined, prompt: undefined, command: silent, timeoutMs: 2000 })]);
    const pi = startPi(sb, { label: 'D11c', approve: true, extensions: [scheduleEntry], script: idle });
    await pi.send({ id: 'state', type: 'get_state' });
    assert.ok(await pi.waitFor(e => e.type === 'response' && e.id === 'state', 30000, 'rpc ready'), 'host must be up (harness sanity)');
    const failed = await waitUntil(async () => (await readStore(sb)).jobs.find(j => j.id === 'cmd-c')?.lastStatus === 'error', 90000, 'command job stall error');
    assert.ok(failed, `the stall deadline must fail the job; store=${JSON.stringify((await readStore(sb)).jobs)}`);
    const pid = Number((await readFile(join(sb.cwd, 'pid.txt'), 'utf8')).trim());
    assert.ok(pid > 0, 'the command must have started and reported its pid');
    const gone = await waitUntil(() => !aliveProcess(pid), 20000, `process ${pid} to be gone`);
    const stored = (await readStore(sb)).jobs.find(j => j.id === 'cmd-c');
    const seen = markers(pi);
    await pi.finish();
    const error = seen.find(m => m.mode === 'command_error');
    assert.ok(error, `a command_error marker must be shown: ${JSON.stringify(seen.map(m => m.mode))}`);
    assert.match(error.error, /no output for 2000 ms/);
    assert.match(error.error, /descendant processes may still be running/);
    assert.ok(gone, 'the stalled process must have been killed by the shell backend (best effort; the message still does not claim a tree stop)');
    assert.equal(stored.runCount, 0, 'a failed run is not counted as a run');
  } finally { await sb.cleanup(); }
});

test('D11d: the schedule_prompt tool saves a command job only after explicit UI confirmation', { timeout: 150000 }, async () => {
  for (const approve of [false, true]) {
    const sb = await makeSandbox(`sp-d11d-${approve ? 'yes' : 'no'}`);
    try {
      const add = { action: 'add', name: 'from-model', type: 'interval', schedule: '1h', command: 'echo from-model', timeoutMs: 5000 };
      const pi = startPi(sb, { label: `D11d-${approve}`, approve: true, extensions: [scheduleEntry], script: [
        { content: [toolCall('schedule_prompt', add, 'add-cmd')] },
        { content: [{ type: 'text', text: 'done' }] },
      ] });
      await pi.send({ id: 'state', type: 'get_state' });
      assert.ok(await pi.waitFor(e => e.type === 'response' && e.id === 'state', 30000, 'rpc ready'), 'host must be up (harness sanity)');
      await pi.send({ id: 'p1', type: 'prompt', message: 'schedule a command' });
      const request = await pi.waitFor(e => e.type === 'extension_ui_request' && e.method === 'confirm', 60000, 'confirmation dialog for the command job');
      assert.ok(request, 'the tool must ask the user before saving a command job');
      assert.match(request.message, /Command: echo from-model/);
      assert.match(request.message, /Runs unattended/);
      assert.deepEqual((await readStore(sb)).jobs, [], 'nothing may be stored before the answer');
      await pi.send({ type: 'extension_ui_response', id: request.id, confirmed: approve });
      const result = await pi.waitFor(e => e.type === 'message_end' && e.message?.role === 'toolResult' && e.message.toolName === 'schedule_prompt', 60000, 'tool result');
      assert.ok(result, 'tool result expected');
      await pi.finish();
      const [r] = toolResults(pi, 'schedule_prompt');
      const stored = (await readStore(sb)).jobs;
      log(`approve=${approve} isError=${r.isError} text=${JSON.stringify(textOf(r))} stored=${stored.map(j => j.name)}`);
      if (approve) {
        assert.notEqual(r.isError, true, textOf(r));
        assert.equal(stored.length, 1);
        assert.equal(stored[0].command, 'echo from-model');
        assert.equal(stored[0].prompt, undefined);
      } else {
        assert.equal(r.isError, true);
        assert.match(textOf(r), /did not confirm/);
        assert.deepEqual(stored, []);
      }
    } finally { await sb.cleanup(); }
  }
});

test('D11e: an explicit bash shell and a non-zero exit are reported as a failed run with the exit code', { timeout: 150000 }, async () => {
  const sb = await makeSandbox('sp-d11e');
  try {
    await writeStore(sb, [job({ id: 'cmd-e', name: 'cmd-e', type: 'once', schedule: soon(3000), intervalMs: undefined, prompt: undefined, shell: 'bash', command: 'echo BASH_OUT; echo BASH_ERR 1>&2; exit 7' })]);
    const pi = startPi(sb, { label: 'D11e', approve: true, extensions: [scheduleEntry], script: idle });
    await pi.send({ id: 'state', type: 'get_state' });
    assert.ok(await pi.waitFor(e => e.type === 'response' && e.id === 'state', 30000, 'rpc ready'), 'host must be up (harness sanity)');
    const failed = await waitUntil(async () => (await readStore(sb)).jobs.find(j => j.id === 'cmd-e')?.lastStatus === 'error', 90000, 'command job failure');
    assert.ok(failed, `the failing command must be recorded; store=${JSON.stringify((await readStore(sb)).jobs)}`);
    const stored = (await readStore(sb)).jobs.find(j => j.id === 'cmd-e');
    const seen = markers(pi);
    await pi.finish();
    assert.equal(stored.runCount, 0);
    const error = seen.find(m => m.mode === 'command_error');
    assert.ok(error, `a command_error marker must be shown: ${JSON.stringify(seen.map(m => m.mode))}`);
    assert.equal(error.shell, 'bash');
    assert.equal(error.exitCode, 7);
    assert.match(error.error, /Command exited with code 7/);
    assert.match(error.error, /BASH_OUT/);
    assert.match(error.error, /BASH_ERR/);
  } finally { await sb.cleanup(); }
});
