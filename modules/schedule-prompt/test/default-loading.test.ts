import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import extension from '../src/index.js';
vi.mock('../src/subagent.js', () => ({ runSubagentOnce: vi.fn() }));
vi.mock('../src/settings.js', () => ({ loadSettings: () => ({ widgetVisible: false }), saveSettings: () => true }));
let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'pi-sp-default-loading-')); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });

// Local adaptation: schedule_prompt and schedule_shell are declared directly (no `exposure`/`namespace`), so Pi activates it like any other
// extension tool. Deferred groups and their discovery hint belong to pi-runtime (modules/pi-runtime tests).
it('schedule_prompt and schedule_shell are registered as directly declared tool, not a deferred group', async () => {
  const tools: any[] = [], hooks = new Map<string, any>();
  await extension({ sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn(), on: () => () => {} },
    registerTool: (t: any) => tools.push(t), registerCommand() {}, registerMessageRenderer() {}, on: (key: string, fn: any) => hooks.set(key, fn) } as any);
  expect(tools.map(t => t.name)).toEqual(['schedule_prompt', 'schedule_shell']);
  for (const tool of tools) { expect(tool.exposure).toBeUndefined(); expect(tool.namespace).toBeUndefined(); }
  await hooks.get('session_shutdown')({}, { cwd, sessionManager: { getSessionId: () => 'owner' }, ui: { setWidget() {}, setStatus() {} } });
});
