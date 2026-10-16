import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import extension from '../src/index.js';
vi.mock('../src/subagent.js', () => ({ runSubagentOnce: vi.fn() }));
vi.mock('../src/settings.js', () => ({ loadSettings: () => ({ widgetVisible: false }), saveSettings: () => true }));
let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'pi-sp-deferred-')); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });

// Activation of tool_search, the fallback and the discovery hint belong to pi-runtime (modules/pi-runtime tests).
it('schedule_prompt is registered as a deferred tool in the schedule namespace', async () => {
  const tools: any[] = [], hooks = new Map<string, any>();
  await extension({ sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn(), on: () => () => {} },
    registerTool: (t: any) => tools.push(t), registerCommand() {}, registerMessageRenderer() {}, on: (key: string, fn: any) => hooks.set(key, fn) } as any);
  expect(tools.map(t => t.name)).toEqual(['schedule_prompt']);
  expect(tools[0].exposure).toBe('deferred');
  expect(tools[0].namespace.name).toBe('schedule');
  expect(hooks.has('before_agent_start')).toBe(false);
  await hooks.get('session_shutdown')({}, { cwd, sessionManager: { getSessionId: () => 'owner' }, ui: { setWidget() {}, setStatus() {} } });
});
