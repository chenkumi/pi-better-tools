import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import themeTools, { THEMES } from '../src/index.ts';

const themesDir = fileURLToPath(new URL('../themes/', import.meta.url));
const shipped = THEMES.filter(entry => entry.theme.startsWith('pi-better-'));

function load() {
  const commands = new Map<string, any>(), handlers: string[] = [];
  themeTools({ registerCommand: (name: string, definition: unknown) => { commands.set(name, definition); }, on: (event: string) => { handlers.push(event); return () => {}; } } as unknown as ExtensionAPI);
  return { commands, handlers };
}
function context(options: { hasUI?: boolean; setTheme?: (name: string) => { success: boolean; error?: string }; select?: (title: string, labels: string[]) => Promise<string | undefined>; current?: string } = {}) {
  const calls: string[] = [], notices: Array<[string, string | undefined]> = [], titles: string[] = [];
  const ctx: any = { hasUI: options.hasUI ?? true, ui: {
    theme: { name: options.current ?? 'dark' },
    setTheme: (name: string) => { calls.push(name); return (options.setTheme ?? (() => ({ success: true })))(name); },
    notify: (message: string, type?: string) => { notices.push([message, type]); },
    select: async (title: string, labels: string[]) => { titles.push(title); return options.select?.(title, labels); },
  } };
  return { ctx, calls, notices, titles };
}

test('registering the extension only adds commands: no events, no settings access at load', () => {
  const { commands, handlers } = load();
  assert.deepEqual(handlers, []);
  assert.ok(!commands.has('theme'), 'a bare /theme collides with Pi commands');
  assert.deepEqual([...commands.keys()].sort(), ['theme:menu', ...THEMES.map(entry => `theme:${entry.id}`)].sort());
});

test('every shipped theme file matches the command table and keeps the full set of color roles', () => {
  const files = readdirSync(themesDir).filter(name => name.endsWith('.json')).sort();
  assert.deepEqual(files, shipped.map(entry => `${entry.theme}.json`).sort());
  const roles = (file: string) => Object.keys(JSON.parse(readFileSync(themesDir + file, 'utf8')).colors).sort();
  const reference = roles(files[0]!);
  for (const file of files) {
    const theme = JSON.parse(readFileSync(themesDir + file, 'utf8'));
    assert.equal(`${theme.name}.json`, file, 'theme name is the file name, which Pi uses to hot-reload the active theme');
    assert.ok(['dark', 'light'].includes(theme.appearance));
    assert.deepEqual(roles(file), reference, `${file} defines every role the others define`);
    for (const key of ['accent', 'dim', 'warning', 'selectedBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']) assert.ok(theme.colors[key], `${file}: ${key}`);
  }
  assert.equal(JSON.parse(readFileSync(themesDir + 'pi-better-paper.json', 'utf8')).appearance, 'light');
});

test('/theme:<id> applies the matching theme by name and says so', async () => {
  const { commands } = load();
  for (const entry of THEMES) {
    const { ctx, calls, notices } = context();
    await commands.get(`theme:${entry.id}`).handler('ignored arguments', ctx);
    assert.deepEqual(calls, [entry.theme]);
    assert.deepEqual(notices, [[`Theme: ${entry.id}`, 'info']]);
  }
});

test('a theme Pi cannot load is reported with the reason and the available names; nothing throws', async () => {
  const { commands } = load();
  const refused = context({ setTheme: () => ({ success: false, error: 'Theme not found: pi-better-moss' }) });
  await commands.get('theme:moss').handler('', refused.ctx);
  assert.equal(refused.notices.length, 1); assert.equal(refused.notices[0]![1], 'warning');
  assert.match(refused.notices[0]![0], /"moss" was not applied: Theme not found: pi-better-moss\. Available: deep-sea, warm-charcoal, moss/);
  const thrown = context({ setTheme: () => { throw new Error('ui disposed'); } });
  await commands.get('theme:signal').handler('', thrown.ctx);
  assert.match(thrown.notices[0]![0], /ui disposed/);
});

test('without a UI nothing is switched', async () => {
  const { commands } = load();
  for (const name of ['theme:paper', 'theme:menu']) {
    const { ctx, calls, notices } = context({ hasUI: false });
    await commands.get(name).handler('deep-sea', ctx);
    assert.deepEqual(calls, []); assert.deepEqual(notices, []);
  }
});

test('/theme:menu opens a picker that marks the current theme and applies the choice', async () => {
  const { commands } = load();
  let seen: string[] = [];
  const picked = context({ current: 'pi-better-moss', select: async (_title, labels) => { seen = labels; return labels[2]; } });
  await commands.get('theme:menu').handler('', picked.ctx);
  assert.deepEqual(picked.titles, ['Theme']); assert.equal(seen.length, THEMES.length);
  assert.match(seen[2]!, /^moss \(current\) — /); assert.equal(seen.filter(label => label.includes('(current)')).length, 1);
  assert.deepEqual(picked.calls, ['pi-better-moss']);
  const cancelled = context({ select: async () => undefined });
  await commands.get('theme:menu').handler('', cancelled.ctx);
  assert.deepEqual(cancelled.calls, []); assert.deepEqual(cancelled.notices, []);
});
