import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CronStorage } from '../src/storage.js';
import { createCronTool } from '../src/tool.js';
import { JobsView } from '../src/ui/jobs-view.js';
import { runJobsMenu } from '../src/ui/jobs-menu.js';
vi.mock('../src/subagent.js', () => ({ runSubagentOnce: vi.fn() }));
let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'pi-review-cleanup-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });
it.each(['tool', 'menu', 'view'])('R13 manual %s cleanup performs one bounded mutation and keeps peer replacements', async route => {
  const storage = new CronStorage(cwd);
  storage.save({ version: 1, jobs: Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: String(i), enabled: false, type: 'interval', schedule: '1h', intervalMs: 3600000, prompt: 'p', createdAt: '', runCount: 0 })) });
  const scheduler = { removeJob: vi.fn(), getNextRun: () => null } as any;
  const reads = vi.spyOn(storage, 'load'), writes = vi.spyOn(storage, 'save');
  let calls = 0;
  const rebindPeer = () => { storage.updateJob('0', { session: 'foreign' }); storage.updateJob('1', { enabled: true }); reads.mockClear(); writes.mockClear(); };
  if (route === 'tool') {
    // No UI wait: fresh predicate must still preserve already changed jobs.
    rebindPeer();
    await createCronTool(() => storage, () => scheduler).execute('cleanup', { action: 'cleanup' }, undefined, undefined, { sessionManager: { getSessionId: () => 'owner' } } as any);
  } else if (route === 'menu') {
    await runJobsMenu({ ui: { select: async () => ++calls === 1 ? 'Cleanup disabled jobs' : 'Back', confirm: async () => { rebindPeer(); return true; } } } as any, storage, scheduler, {}, 'owner');
  } else {
    const view = new JobsView(storage, scheduler, 'owner', async () => {}, {}, () => {}, () => {});
    view.handleInput('c'); rebindPeer(); view.handleInput('y');
  }
  // Menu/view refresh once after the mutation; tool has no post-mutation reload.
  expect(reads).toHaveBeenCalledTimes(route === 'tool' ? 1 : 2);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(scheduler.removeJob).toHaveBeenCalledTimes(8);
  expect(storage.getAllJobs().map(j => j.id)).toEqual(['0', '1']);
});
