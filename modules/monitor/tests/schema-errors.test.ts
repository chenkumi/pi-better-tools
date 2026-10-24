// Regression for the reported monitor_start reply: a 20 s job interval used to fail in the host's TypeBox union, which
// answers with one error per branch ("schema is false", "must be equal to constant") and never names the cause. The
// host-facing schema must accept it structurally so validateStart can explain the bound and the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import { startSchema, validateStart } from '../src/schema.ts';

const job = (intervalMs: number) => ({ source: { kind: 'shell_job', jobId: 'JOB', intervalMs } });

test('host-facing schema accepts every structurally valid source so the strict layer owns the message', () => {
  for (const value of [
    job(20000),
    { source: { kind: 'command', tool: 'bash', command: 'printf ok' } },
    { source: { kind: 'websocket', url: 'wss://example.org/socket' } },
    { source: { kind: 'file', path: 'a.txt', intervalMs: 2000 } },
    { source: { kind: 'fork_job', jobId: 'JOB' }, durationMs: 900 },
  ]) assert.equal(Value.Check(startSchema, value), true, JSON.stringify(value));
});

test('a rejected monitor_start names the parameter, the accepted range and the fix', () => {
  const cases: Array<[unknown, RegExp]> = [
    [job(20000), /shell_job source "intervalMs" 20000 is out of range: use an integer 30000–300000 ms \(default 60000; job sampling cannot be faster than 30000 ms\)/],
    [{ source: { kind: 'file', path: 'a.txt', intervalMs: 90000 } }, /file source "intervalMs" 90000 is out of range: use an integer 1000–60000 ms \(default 2000\)/],
    [{ source: { kind: 'shell_job' } }, /shell_job source "jobId" must be a non-empty string; pass the job id returned when that job started/],
    [{ source: { kind: 'command', tool: 'pwsh', command: 'x' } }, /command source "tool" "pwsh" is unsupported: set it to "bash" or "powershell"/],
    [{ source: { kind: 'websocket' } }, /websocket source "url" must be a non-empty string; use wss:\/\/host\/path without userinfo/],
    [{ source: { kind: 'file', path: 'a.txt', content: true } }, /Unknown Monitor parameter "content": a file source accepts kind, path, intervalMs/],
    [{ source: { kind: 'nope' } }, /source "kind" "nope" is unsupported: use command, websocket, shell_job, subagent_job, fork_job, file/],
    [{ source: { kind: 'file', path: 'a.txt' }, durationMs: 900 }, /"durationMs" 900 is out of range: use an integer 1000–1800000 ms \(default 300000\)/],
    [{ source: { kind: 'file', path: 'a.txt' }, wakeAgent: 'yes' }, /"wakeAgent" must be a boolean: true \(default\) requests a model turn, false saves the batch for the next turn without rendering it; received "yes"/],
    [{ source: { kind: 'file', path: 'a.txt' }, extra: 1 }, /Unknown Monitor parameter "extra": monitor_start accepts source, durationMs, wakeAgent, stopAfterEvents, label/],
  ];
  for (const [value, expected] of cases) assert.throws(() => validateStart(value), expected, JSON.stringify(value));
});

test('a valid start still normalizes defaults and sanitized label', () => {
  const start = validateStart({ source: { kind: 'shell_job', jobId: 'JOB', intervalMs: 30000 }, label: 'a\u001bb' });
  assert.deepEqual(start.source, { kind: 'shell_job', jobId: 'JOB', intervalMs: 30000 });
  assert.equal(start.durationMs, 300000); assert.equal(start.wakeAgent, true); assert.equal(start.label, 'ab');
});
