import * as fs from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import extension from '../src/index.js';
import { CronStorage } from '../src/storage.js';
import { CronScheduler } from '../src/scheduler.js';
import type { CronJob } from '../src/types.js';
vi.mock('fs', async original => {
  const actual = await original<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), renameSync: vi.fn(actual.renameSync) };
});
vi.mock('../src/settings.js', () => ({ loadSettings: () => ({ widgetVisible: false }), saveSettings: () => true }));
vi.mock('../src/subagent.js', () => ({ runSubagentOnce: vi.fn() }));
// node:fs and fs share Vitest mock identity; bypass mocks explicitly.
const actualFs = await vi.importActual<typeof import('fs')>('fs');
let cwd: string;
const job = (enabled = true): CronJob => ({ id: 'precious', name: 'precious', enabled, schedule: '5m', type: 'interval', intervalMs: 300000, prompt: 'p', createdAt: '', runCount: 0 });
beforeEach(() => { cwd = actualFs.mkdtempSync(join(tmpdir(), 'pi-schedule-fix-')); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fs.readFileSync).mockImplementation(actualFs.readFileSync); vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync); actualFs.rmSync(cwd, { recursive: true, force: true }); vi.useRealTimers(); });

it.each(['EACCES', 'EIO'])('does not overwrite existing data after read %s', code => {
  const storage = new CronStorage(cwd); storage.addJob(job());
  const target = storage.getStorePath(), original = actualFs.readFileSync(target, 'utf8');
  vi.mocked(fs.readFileSync).mockImplementation(((path: any, ...args: any[]) => {
    if (String(path) === target) throw Object.assign(new Error('injected read error'), { code });
    return (actualFs.readFileSync as any)(path, ...args);
  }) as any);
  expect(() => storage.addJob({ ...job(), id: 'new' })).toThrow(/refusing to replace/);
  expect(() => storage.updateJob('precious', { enabled: false })).toThrow(/refusing to replace/);
  expect(() => storage.removeJob('precious')).toThrow(/refusing to replace/);
  expect(actualFs.readFileSync(target, 'utf8')).toBe(original);
  expect(actualFs.readdirSync(join(cwd, '.pi'))).toEqual(['schedule-prompts.json']);
});
it('refuses save when corrupt input cannot be preserved', () => {
  const storage = new CronStorage(cwd), target = storage.getStorePath();
  actualFs.mkdirSync(join(cwd, '.pi')); actualFs.writeFileSync(target, '{precious damaged content');
  vi.mocked(fs.renameSync).mockImplementation(((from: any, to: any) => {
    if (String(from) === target) throw Object.assign(new Error('injected quarantine error'), { code: 'EACCES' });
    return actualFs.renameSync(from, to);
  }) as any);
  expect(() => storage.addJob(job())).toThrow(/Cannot preserve corrupt/);
  expect(actualFs.readFileSync(target, 'utf8')).toBe('{precious damaged content');
});
it('tolerates a peer quarantining the corrupt store first (ENOENT on rename)', () => {
  const storage = new CronStorage(cwd), target = storage.getStorePath();
  actualFs.mkdirSync(join(cwd, '.pi')); actualFs.writeFileSync(target, '{damaged');
  vi.mocked(fs.renameSync).mockImplementation(((from: any, to: any) => {
    if (String(from) === target) {
      actualFs.renameSync(target, `${target}.corrupt-peer`);
      throw Object.assign(new Error('peer won the race'), { code: 'ENOENT' });
    }
    return actualFs.renameSync(from, to);
  }) as any);
  expect(() => storage.getAllJobs()).not.toThrow();
  expect(storage.getAllJobs()).toEqual([]);
  expect(actualFs.readFileSync(`${target}.corrupt-peer`, 'utf8')).toBe('{damaged');
});
it('refuses an ENOENT quarantine error when the source still exists', () => {
  const storage = new CronStorage(cwd), target = storage.getStorePath();
  actualFs.mkdirSync(join(cwd, '.pi')); actualFs.writeFileSync(target, '{damaged');
  vi.mocked(fs.renameSync).mockImplementation(((from: any, to: any) => {
    if (String(from) === target) throw Object.assign(new Error('ambiguous ENOENT'), { code: 'ENOENT' });
    return actualFs.renameSync(from, to);
  }) as any);
  expect(() => storage.addJob(job())).toThrow(/Cannot preserve corrupt/);
  expect(actualFs.readFileSync(target, 'utf8')).toBe('{damaged');
});
it('cron validation owns no timer, including a later rejected deadline', () => {
  vi.useFakeTimers();
  const baseline = vi.getTimerCount();
  for (let i = 0; i < 10; i++) expect(CronScheduler.validateCronExpression('0 0 0 1 1 *').valid).toBe(true);
  expect(CronScheduler.validateCronExpression('INVALID INVALID INVALID INVALID INVALID INVALID').valid).toBe(false);
  expect(vi.getTimerCount()).toBe(baseline);
});
it.each(['session_shutdown', 'session_start'])('%s always stops the old scheduler after optional cleanup fails', async name => {
  const storage = new CronStorage(cwd); storage.addJob(job(false));
  const hooks = new Map<string, any>();
  await extension({ registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, events: { on: () => () => {}, emit() {} }, on: (key: string, fn: any) => hooks.set(key, fn) } as any);
  const ctx = { cwd, mode: 'rpc', hasUI: false, sessionManager: { getSessionId: () => 'owner' }, ui: { setWidget() {}, setStatus() {} } };
  await hooks.get('session_start')({ reason: 'startup' }, ctx);
  const stop = vi.spyOn(CronScheduler.prototype, 'stop');
  const remove = vi.spyOn(CronStorage.prototype, 'removeJob').mockImplementation(() => { throw new Error('injected save failure'); });
  if (name === 'session_shutdown') await expect(hooks.get(name)({}, ctx)).rejects.toThrow(/injected/);
  else await hooks.get(name)({ reason: 'switch' }, ctx);
  expect(stop).toHaveBeenCalled();
  remove.mockRestore(); await hooks.get('session_shutdown')({}, ctx);
});
