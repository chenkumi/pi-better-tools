import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import imageGeneration from '../src/index.ts';
import { tempDir } from './helpers.ts';

function host() {
  const tools: Array<Record<string, unknown>> = [], commands: string[] = [];
  const pi = { registerTool: (tool: Record<string, unknown>) => tools.push(tool), registerCommand: (name: string) => commands.push(name), on() {}, events: { on() {}, emit() {} } };
  return { pi: pi as never, tools, commands };
}

test('the extension registers the deferred image tool and the settings command', async t => {
  const h = host();
  const path = join(await tempDir(t), 'on.json');
  await writeFile(path, JSON.stringify({ enabled: true }));
  imageGeneration(h.pi, { configPath: path });
  assert.deepEqual(h.tools.map(tool => tool.name), ['image_generate']);
  assert.equal(h.tools[0]!.exposure, 'deferred'); assert.equal((h.tools[0]!.namespace as { name: string }).name, 'image');
  assert.deepEqual(h.commands, ['settings:image-generation']);
});

test('loading the extension reads and writes nothing: a broken configuration only fails when the tool runs', async t => {
  const h = host();
  const path = join(await tempDir(t), 'bad.json');
  await writeFile(path, '{ broken');
  imageGeneration(h.pi, { configPath: path });
  assert.equal(h.tools.length, 1, 'registered so that the call can report the broken file');
  const none = host();
  imageGeneration(none.pi, { configPath: join(await tempDir(t), 'missing.json') });
  assert.deepEqual(none.tools, [], 'no file means the default, which is off');
});

test('enabled:false registers only the settings command, and a call is refused if it is turned off later', async t => {
  const path = join(await tempDir(t), 'c.json');
  await writeFile(path, JSON.stringify({ enabled: false }));
  const h = host();
  imageGeneration(h.pi, { configPath: path });
  assert.deepEqual(h.tools, []); assert.deepEqual(h.commands, ['settings:image-generation']);
  await writeFile(path, JSON.stringify({ enabled: true }));
  const on = host();
  imageGeneration(on.pi, { configPath: path });
  await writeFile(path, JSON.stringify({ enabled: false }));
  await assert.rejects((on.tools[0] as { execute: (...a: unknown[]) => Promise<unknown> }).execute('i', { prompt: 'x' }, undefined, undefined, { cwd: process.cwd() }), /IMAGE_BACKEND_DISABLED: Image generation is turned off/);
});

// Keep last: the guard handshake is consumed once per process and stays set.
test('a Subagent child gets neither the tool nor the command', () => {
  process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ shellMode: 'foreground-v1', id: 'child', cwd: process.cwd(), startupPath: process.cwd() });
  const h = host();
  imageGeneration(h.pi);
  assert.deepEqual(h.tools, []); assert.deepEqual(h.commands, []);
});
