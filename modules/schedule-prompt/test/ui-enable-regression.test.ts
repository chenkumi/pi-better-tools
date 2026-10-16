import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CronStorage } from '../src/storage.js';
import { CronScheduler } from '../src/scheduler.js';
import { defaultCommandShell } from '../src/command.js';
import { runJobsMenu } from '../src/ui/jobs-menu.js';
import { JobsView } from '../src/ui/jobs-view.js';
import type { CronJob } from '../src/types.js';
vi.mock('../../shell-tools/src/monitor-exec.ts', () => ({ execMonitorCommand: vi.fn() }));
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
let root: string, cwd: string, outside: string, storage: CronStorage, peer: CronStorage, scheduler: CronScheduler, ctx: any;
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const current = () => storage.getJob('approval-job')!;
const view = () => new JobsView(storage, scheduler, 'session', async () => {}, theme, () => {}, () => {});
function seed(over: Partial<CronJob> = {}) {
  storage.addJob({ id: 'approval-job', name: 'approval', type: 'interval', schedule: '1s', intervalMs: 1000, command: 'echo SHOWN', shell: defaultCommandShell(), cwd, enabled: false, session: 'session', runCount: 0, createdAt: '', ...over });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'schedule-enable-regression-')));
  cwd = join(root, 'project'); outside = join(root, 'outside');
  mkdirSync(cwd); mkdirSync(outside);
  storage = new CronStorage(cwd); peer = new CronStorage(cwd);
  ctx = { cwd, hasUI: true, mode: 'tui', sessionManager: { getSessionId: () => 'session', getEntries: () => [] }, ui: { select: vi.fn(), confirm: vi.fn(), notify: vi.fn() } };
  scheduler = new CronScheduler(storage, { sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn() }, getSettings: () => ({}) } as any, ctx);
});
afterEach(async () => { scheduler.stop(); await scheduler.drain(100); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
function menu() {
  let selected = false;
  ctx.ui.select.mockImplementation(async (title: string, options: string[]) => {
    if (title.startsWith('Jobs')) { if (selected) return 'Back'; selected = true; return options.find(x => x.includes('approval-job')); }
    return 'Enable';
  });
  return runJobsMenu(ctx, storage, scheduler, {}, 'session');
}
for (const field of ['command', 'cwd', 'shell', 'session', 'schedule', 'timeoutMs'] as const) {
  it(`SCH-01 menu preserves peer bytes and refuses changed ${field}`, async () => {
    seed(); const entered = deferred<string>(), answer = deferred<boolean>();
    ctx.ui.confirm.mockImplementation((_t: string, message: string) => { entered.resolve(message); return answer.promise; });
    const pending = menu(); expect(await entered.promise).toContain('SHOWN');
    const values = { command: 'echo UNSEEN', cwd: outside, shell: defaultCommandShell() === 'bash' ? 'powershell' : 'bash', session: 'other', schedule: '2s', timeoutMs: 1234 };
    peer.updateJob('approval-job', { [field]: values[field], ...(field === 'schedule' ? { intervalMs: 2000 } : {}) });
    const bytes = readFileSync(join(cwd, '.pi/schedule-prompts.json'), 'utf8');
    answer.resolve(true); await pending;
    expect(readFileSync(join(cwd, '.pi/schedule-prompts.json'), 'utf8')).toBe(bytes);
    expect(current().enabled).toBe(false);
    expect(scheduler.commandApprovals.isApproved(current().command!, current().shell!, current().cwd!)).toBe(false);
  });
}
it('SCH-01 menu enables the exact unchanged spec only after approval', async () => {
  seed({ cwd: outside }); ctx.ui.confirm.mockResolvedValue(true); await menu();
  expect(current().enabled).toBe(true);
  expect(scheduler.commandApprovals.isApproved(current().command!, current().shell!, outside)).toBe(true);
});
it('SCH-01 overlay rejects a fresh spec that differs from the visible snapshot', () => {
  seed(); const ui = view(); expect(ui.render(100).join('\n')).toContain('SHOWN');
  peer.updateJob('approval-job', { command: 'echo UNSEEN', cwd: outside });
  ui.handleInput('t'); ui.handleInput('y');
  expect(current().enabled).toBe(false);
  expect(scheduler.commandApprovals.isApproved('echo UNSEEN', defaultCommandShell(), outside)).toBe(false);
});
it('SCH-01 overlay compares again under lock after the confirmation is rendered', () => {
  seed(); const ui = view(); ui.render(100); ui.handleInput('t'); ui.render(100);
  peer.updateJob('approval-job', { command: 'echo UNSEEN', session: 'other' });
  const bytes = readFileSync(join(cwd, '.pi/schedule-prompts.json'), 'utf8');
  ui.handleInput('y');
  expect(readFileSync(join(cwd, '.pi/schedule-prompts.json'), 'utf8')).toBe(bytes);
  expect(current().enabled).toBe(false);
});
it('SCH-03 overlay reviews all pages of a long command before explicit y can approve', () => {
  const prefix = 'echo SAFE ', suffix = '; echo VISIBLE_TAIL';
  const command = prefix + 'x'.repeat(8000 - prefix.length - suffix.length) + suffix;
  expect(command.length).toBe(8000); seed({ command, cwd: outside });
  const ui = view(); ui.render(60); ui.handleInput('t');
  expect(current().enabled).toBe(false);
  const pages: string[] = [];
  for (let i = 0; i < 500; i++) {
    const text = ui.render(60).join('\n'); pages.push(text);
    if (text.includes('VISIBLE_TAIL')) break;
    ui.handleInput('y'); expect(current().enabled).toBe(false);
    ui.handleInput('\x1b[C');
  }
  expect(pages.join('\n')).toContain('VISIBLE_TAIL');
  ui.handleInput('y'); expect(current().enabled).toBe(true);
  expect(scheduler.commandApprovals.isApproved(command, defaultCommandShell(), outside)).toBe(true);
});
it('SCH-03 cancel or confirming before render never grants approval', () => {
  seed({ cwd: outside }); const ui = view(); ui.render(100); ui.handleInput('t'); ui.handleInput('y');
  expect(current().enabled).toBe(false);
  ui.render(100); ui.handleInput('n'); expect(current().enabled).toBe(false);
  expect(scheduler.commandApprovals.isApproved(current().command!, defaultCommandShell(), outside)).toBe(false);
});
it('ordinary prompt toggles remain immediate', () => {
  seed({ command: undefined, shell: undefined, cwd: undefined, prompt: 'hello' }); const ui = view(); ui.handleInput('t'); expect(current().enabled).toBe(true);
  ui.handleInput('t'); expect(current().enabled).toBe(false);
});
it('disabling an enabled command is immediate and grants no approval', () => {
  seed({ enabled: true, cwd: outside }); const ui = view(); ui.handleInput('t');
  expect(current().enabled).toBe(false);
  expect(scheduler.commandApprovals.isApproved(current().command!, defaultCommandShell(), outside)).toBe(false);
});
it('storage refusal never grants command approval', () => {
  seed({ cwd: outside }); const ui = view(); ui.handleInput('t'); ui.render(100);
  vi.spyOn(storage, 'updateJobWith').mockImplementation(() => { throw new Error('injected lock/write refusal'); });
  ui.handleInput('y'); expect(current().enabled).toBe(false);
  expect(scheduler.commandApprovals.isApproved(current().command!, defaultCommandShell(), outside)).toBe(false);
  expect(ui.render(100).join('\n')).toContain('injected lock/write refusal');
});
it('a disappeared directory rolls the enable back without approval', () => {
  seed({ cwd: outside }); const ui = view(); ui.handleInput('t'); ui.render(100);
  rmSync(outside, { recursive: true }); ui.handleInput('y');
  expect(current().enabled).toBe(false);
  expect(scheduler.commandApprovals.isApproved(current().command!, defaultCommandShell(), outside)).toBe(false);
});
it('batched navigation without renders cannot skip review pages', () => {
  seed({ command: 'x'.repeat(8000), cwd: outside }); const ui = view(); ui.handleInput('t'); ui.render(60);
  for (let i = 0; i < 500; i++) ui.handleInput('\x1b[C');
  const page = ui.render(60).join('\n');
  ui.handleInput('y'); expect(current().enabled).toBe(false);
  expect(page).toContain('Page 2/');
});
it('height or width changes restart review instead of skipping content ranges', () => {
  seed({ command: 'x'.repeat(2000), cwd: outside }); let rows = 7;
  const ui = new JobsView(storage, scheduler, 'session', async () => {}, theme, () => {}, () => {}, undefined, () => rows);
  ui.handleInput('t'); ui.render(60); ui.handleInput('\x1b[C'); ui.render(60);
  rows = 18; expect(ui.render(60).join('\n')).toContain('Page 1/');
  ui.handleInput('\x1b[C'); ui.render(60);
  expect(ui.render(100).join('\n')).toContain('Page 1/');
  ui.handleInput('y'); expect(current().enabled).toBe(false);
});
it('failed approval plus failed rollback reports the saved state and stops local scheduling', () => {
  seed({ cwd: outside }); const ui = view(); ui.handleInput('t'); ui.render(100);
  const update = storage.updateJobWith.bind(storage); let calls = 0;
  vi.spyOn(storage, 'updateJobWith').mockImplementation((...args) => {
    if (++calls === 2) throw new Error('injected rollback failure');
    return update(...args);
  });
  const remove = vi.spyOn(scheduler, 'removeJob');
  rmSync(outside, { recursive: true }); ui.handleInput('y');
  expect(current().enabled).toBe(true); // persistence is uncertain; never report a clean rollback
  expect(remove).toHaveBeenCalledWith('approval-job');
  expect(ui.render(200).join('\n')).toContain('rollback is unconfirmed');
  expect(scheduler.commandApprovals.isApproved(current().command!, defaultCommandShell(), outside)).toBe(false);
});
it('confirmation respects a short terminal and refuses approval when no body fits', () => {
  seed(); let rows = 10;
  const ui = new JobsView(storage, scheduler, 'session', async () => {}, theme, () => {}, () => {}, undefined, () => rows);
  ui.handleInput('t'); expect(ui.render(40).length).toBeLessThanOrEqual(rows);
  ui.handleInput('y'); expect(current().enabled).toBe(false);
  rows = 4; ui.render(40); ui.handleInput('y'); expect(current().enabled).toBe(false);
  ui.handleInput('n'); expect(current().enabled).toBe(false);
});
