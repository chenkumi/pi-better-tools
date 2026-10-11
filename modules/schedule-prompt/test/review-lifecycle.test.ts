import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import extension from '../src/index.js';
import { CronScheduler } from '../src/scheduler.js';
import { CronStorage } from '../src/storage.js';
import type { CronJob } from '../src/types.js';
vi.mock('../src/subagent.js', () => ({ runSubagentOnce: vi.fn() }));
vi.mock('../src/settings.js', () => ({ loadSettings: () => ({ widgetVisible: false }), saveSettings: () => true }));
let cwd: string;
const job = (id = 'j', overrides: Partial<CronJob> = {}): CronJob => ({ id, name: id, schedule: '1h', intervalMs: 3600000, type: 'interval', prompt: 'offline', enabled: true, createdAt: '', runCount: 0, ...overrides });
const ctx = () => ({ cwd, mode: 'rpc', hasUI: false, isProjectTrusted: () => true, sessionManager: { getSessionId: () => 'owner' }, ui: { setWidget() {}, setStatus() {} } });
function seed(jobs: CronJob[]) { mkdirSync(join(cwd, '.pi'), { recursive: true }); writeFileSync(join(cwd, '.pi/schedule-prompts.json'), JSON.stringify({ version: 1, jobs })); return new CronStorage(cwd); }
function pi() { return { sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn(), on: () => () => {} } }; }
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'pi-review-lifecycle-')); vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z')); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(cwd, { recursive: true, force: true }); });

it.each(['once', 'interval', 'cron', 'stop', 'foreign'] as const)('R12: successful once continuation cannot overwrite synchronous %s replacement', async replacement => {
  const original = job('j', { type: 'once', schedule: new Date(Date.now() + 10000).toISOString(), intervalMs: undefined });
  const storage = seed([original]), api = pi(), scheduler = new CronScheduler(storage, api as any, ctx() as any);
  let changed = false;
  api.events.emit.mockImplementation(() => {
    if (changed || storage.getJob('j')?.runCount !== 1) return;
    changed = true;
    if (replacement === 'stop') { scheduler.stop(); return; }
    const updated = { ...original, enabled: true, type: replacement === 'foreign' ? 'once' : replacement,
      schedule: replacement === 'interval' ? '1h' : replacement === 'cron' ? '0 0 * * * *' : new Date(Date.now() + 20000).toISOString(),
      intervalMs: replacement === 'interval' ? 3600000 : undefined,
      session: replacement === 'foreign' ? 'another-owner' : undefined } as CronJob;
    storage.updateJob('j', updated); scheduler.updateJob('j', updated);
  });
  try {
    scheduler.start(); await vi.advanceTimersByTimeAsync(10000);
    expect(changed).toBe(true); expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(storage.getJob('j')?.enabled).toBe(true);
    if (replacement === 'stop' || replacement === 'foreign') expect(vi.getTimerCount()).toBe(0);
    else { expect(scheduler.getNextRun('j')).not.toBeNull(); expect(vi.getTimerCount()).toBe(1); }
  } finally { scheduler.stop(); }
});

it.each(['foreign', 'schedule'])('R12 supplemental: locked once settlement preserves a peer %s edit without local reschedule', async edit => {
  const original = job('j', { type: 'once', schedule: new Date(Date.now() + 10000).toISOString(), intervalMs: undefined });
  const storage = seed([original]), api = pi(), scheduler = new CronScheduler(storage, api as any, ctx() as any);
  let changed = false, peerBytes = '';
  api.events.emit.mockImplementation(() => {
    if (changed || storage.getJob('j')?.runCount !== 1) return;
    changed = true;
    storage.updateJob('j', edit === 'foreign' ? { session: 'foreign' } : { schedule: new Date(Date.now() + 20000).toISOString() });
    peerBytes = readFileSync(storage.getStorePath(), 'utf8');
  });
  try {
    scheduler.start(); await vi.advanceTimersByTimeAsync(10000);
    expect(changed).toBe(true); expect(storage.getJob('j')?.enabled).toBe(true);
    expect(readFileSync(storage.getStorePath(), 'utf8')).toBe(peerBytes);
    expect(vi.getTimerCount()).toBe(0);
  } finally { scheduler.stop(); }
});

it.each([10, 100])('R13 startup: %i interval jobs use one full-store read and trigger still reads fresh', async count => {
  const storage = seed(Array.from({ length: count }, (_, i) => job(String(i))));
  const reads = vi.spyOn(storage, 'load'), scheduler = new CronScheduler(storage, pi() as any, ctx() as any);
  try {
    scheduler.start(); expect(reads).toHaveBeenCalledTimes(1);
    storage.updateJob('0', { enabled: false }); reads.mockClear();
    await (scheduler as any).fire(job('0')); expect(reads).toHaveBeenCalledTimes(1);
  } finally { scheduler.stop(); }
});

it.each([10, 100])('R13 cleanup: %i disabled jobs use one locked full-store read/write and preserve foreign jobs', async count => {
  seed([...Array.from({ length: count }, (_, i) => job(String(i), { enabled: false, session: i % 2 ? 'owner' : undefined })), job('foreign', { enabled: false, session: 'foreign' }), job('enabled')]);
  const hooks = new Map<string, any>();
  await extension({ ...pi(), registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, on: (key: string, fn: any) => hooks.set(key, fn) } as any);
  await hooks.get('session_start')({ reason: 'startup' }, ctx());
  const reads = vi.spyOn(CronStorage.prototype, 'load'), writes = vi.spyOn(CronStorage.prototype, 'save');
  await hooks.get('session_shutdown')({}, ctx());
  expect(reads).toHaveBeenCalledTimes(1); expect(writes).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(join(cwd, '.pi/schedule-prompts.json'), 'utf8')).jobs.map((j: CronJob) => j.id)).toEqual(['foreign', 'enabled']);
});

it.each([1, 0.5, 1000, 3600001])('R14: persisted hourly cache %s is rejected with diagnostic and no timer', cached => {
  const storage = seed([job('bad', { intervalMs: cached })]), scheduler = new CronScheduler(storage, pi() as any, ctx() as any);
  try { scheduler.start(); expect(vi.getTimerCount()).toBe(0); expect(storage.getAllJobs()).toEqual([]); expect(console.error).toHaveBeenCalledWith(expect.stringContaining('interval')); }
  finally { scheduler.stop(); }
});
it.each(['1s', '1h'])('R14: valid legacy %s remains supported without statistics', schedule => {
  const legacy = job('legacy', { schedule, intervalMs: schedule === '1s' ? 1000 : 3600000 });
  delete (legacy as any).createdAt; delete (legacy as any).runCount;
  const storage = seed([legacy]), scheduler = new CronScheduler(storage, pi() as any, ctx() as any);
  try { scheduler.start(); expect(storage.getAllJobs()).toHaveLength(1); expect(vi.getTimerCount()).toBe(1); } finally { scheduler.stop(); }
});
