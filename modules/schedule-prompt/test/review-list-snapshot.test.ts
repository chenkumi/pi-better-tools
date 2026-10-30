import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CronStorage } from '../src/storage.js';
import { CronScheduler } from '../src/scheduler.js';
import { createPromptTool } from '../src/tool.js';
vi.mock('../src/subagent.js', () => ({ runSubagentOnce: vi.fn() }));

it.each([10, 100, 500])('list %i active jobs loads the store once and keeps next-run filtering', async count => {
  const cwd = mkdtempSync(join(tmpdir(), 'schedule-list-snapshot-'));
  vi.useFakeTimers();
  const storage = new CronStorage(cwd);
  const ctx = { isProjectTrusted: () => true, sessionManager: { getSessionId: () => 'owner', getEntries: () => [] } } as any;
  const scheduler = new CronScheduler(storage, { events: { emit: () => {} } } as any, ctx);
  try {
    storage.save({ version: 1, jobs: Array.from({ length: count }, (_, i) => ({ id: String(i), name: String(i), enabled: true, type: 'interval', schedule: '1h', intervalMs: 3600000, prompt: 'p', createdAt: '', runCount: 0, session: 'owner' })) });
    scheduler.start();
    const reads = vi.spyOn(storage, 'load');
    const result = await createPromptTool(() => storage, () => scheduler).execute('list', { action: 'list' }, undefined, undefined, ctx);
    expect(result.details?.error).toBeUndefined();
    expect(result.details?.jobs).toHaveLength(count);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(result.content[0].text.match(/Next:/g)).toHaveLength(count);
    expect(scheduler.getNextRun('0', { ...result.details!.jobs![0], enabled: false })).toBe(null);
    expect(scheduler.getNextRun('0', { ...result.details!.jobs![0], endAt: new Date(Date.now() - 1).toISOString() })).toBe(null);
    expect(reads).toHaveBeenCalledTimes(1);
  } finally { scheduler.stop(); vi.restoreAllMocks(); vi.useRealTimers(); rmSync(cwd, { recursive: true, force: true }); }
});
