import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { executeWithDebugLog, logToolExecutionFailure, logToolFailure, projectNameFromCwd } from '../../src/debug-log.ts';

const date = (day: number) => new Date(Date.UTC(2026, 8, day, 12));

test('project log directory name is a safe normalized host-native cwd basename', () => {
  const parent = resolve('work');
  assert.equal(projectNameFromCwd(join(parent, 'my-project')), 'my-project');
  assert.equal(projectNameFromCwd(join(parent, 'my project')), 'my_project');
  assert.equal(projectNameFromCwd(join(parent, 'CON')), '_CON');
  assert.match(projectNameFromCwd(join(parent, 'CON'))!, /^[A-Za-z0-9._-]+$/);
  assert.equal(projectNameFromCwd(join(parent, 'my-project') + sep), 'my-project');
  assert.equal(projectNameFromCwd(join(parent, 'Ｍｙ project')), 'My_project');
  // A backslash is a valid filename character on POSIX, not a foreign separator.
  if (process.platform !== 'win32') {
    assert.equal(projectNameFromCwd(join(parent, 'my\\project')), 'my_project');
    assert.equal(projectNameFromCwd('C:\\work\\my-project'), 'C__work_my-project');
  }
});

test('only exact settings.<project_name>.debugLog true enables a bounded redacted error record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-debug-log-'));
  try {
    const settings = join(root, 'settings.json'), logs = join(root, 'logs');
    await writeFile(settings, JSON.stringify({ 'my-project': { debugLog: true } }));
    const path = await logToolFailure({ cwd: join(root, 'my-project'), toolName: 'web_fetch',
      error: new Error('Fetch failed https://example.com/private?api_key=SECRET Bearer abcdef-secret'),
      settingsPath: settings, logsRoot: logs, now: date(30) });
    assert.equal(path, join(logs, 'my-project', 'tool-errors-2026-09-30.jsonl'));
    const [line] = (await readFile(path!, 'utf8')).trim().split('\n');
    const record = JSON.parse(line!);
    assert.equal(record.project, 'my-project');
    assert.equal(record.tool, 'web_fetch');
    assert.equal(record.timestamp, date(30).toISOString());
    assert.match(record.error.message, /api_key=\[REDACTED\]/);
    assert.match(record.error.message, /Bearer \[REDACTED\]/);
    assert.ok(!line!.includes('SECRET'));
    assert.ok(!line!.includes('abcdef-secret'));
    assert.ok(!line!.includes('tool args'));
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(logs, 'my-project'))).mode & 0o777, 0o700);
      assert.equal((await stat(path!)).mode & 0o777, 0o600);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('disabled, malformed, and missing settings fail closed without creating log directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-debug-log-'));
  try {
    const settings = join(root, 'settings.json'), logs = join(root, 'logs'), cwd = join(root, 'app');
    await mkdir(cwd);
    await writeFile(settings, JSON.stringify({ app: { debugLog: 1 }, other: { debugLog: true } }));
    assert.equal(await logToolFailure({ cwd, toolName: 'web_fetch', error: Error('x'), settingsPath: settings, logsRoot: logs }), undefined);
    await writeFile(settings, '{bad json');
    assert.equal(await logToolFailure({ cwd, toolName: 'web_fetch', error: Error('x'), settingsPath: settings, logsRoot: logs }), undefined);
    assert.equal(await logToolFailure({ cwd, toolName: 'web_fetch', error: Error('x'), settingsPath: join(root, 'missing'), logsRoot: logs }), undefined);
    await assert.rejects(stat(logs), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('per-day logs stay below size cap and retain at most seven daily files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-debug-log-'));
  try {
    const settings = join(root, 'settings.json'), logs = join(root, 'logs'), cwd = join(root, 'bounded');
    await writeFile(settings, JSON.stringify({ bounded: { debugLog: true } }));
    for (let day = 1; day <= 10; day++) await logToolFailure({ cwd, toolName: 'web_search', error: Error(`failure ${day}`), settingsPath: settings, logsRoot: logs, now: date(20 + day) });
    const directory = join(logs, 'bounded'), files = await readdir(directory);
    assert.equal(files.length, 7);
    assert.ok(files.includes('tool-errors-2026-09-30.jsonl'));
    assert.ok(!files.includes('tool-errors-2026-09-23.jsonl'));
    const full = join(directory, 'tool-errors-2026-09-30.jsonl');
    await writeFile(full, 'x'.repeat(2 * 1024 * 1024));
    assert.equal(await logToolFailure({ cwd, toolName: 'web_search', error: Error('beyond cap'), settingsPath: settings, logsRoot: logs, now: date(30) }), undefined);
    assert.equal((await stat(full)).size, 2 * 1024 * 1024);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('execution wrapper logs failures best-effort, preserves original rejection, and does not log success', async () => {
  const failure = new Error('original failure'), calls: unknown[][] = [];
  const writer: typeof logToolExecutionFailure = async (ctx, tool, error) => { calls.push([ctx, tool, error]); };
  const success = await executeWithDebugLog({ cwd: '/project' }, 'web_fetch', async () => 42, writer);
  assert.equal(success, 42); assert.equal(calls.length, 0);
  await assert.rejects(executeWithDebugLog({ cwd: '/project' }, 'web_search', async () => { throw failure; }, writer), e => e === failure);
  assert.equal(calls.length, 1);
  await assert.rejects(executeWithDebugLog(undefined, 'web_fetch', async () => { throw failure; }, async () => { throw Error('logger failure'); }), e => e === failure);
});
