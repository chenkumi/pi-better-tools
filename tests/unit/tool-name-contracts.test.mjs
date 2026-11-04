import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FORK_TOOLS, MONITOR_TOOLS, SHELL_JOB_TOOLS, SHELL_TOOLS, SUBAGENT_TOOLS } from '../../shared/src/contracts/index.ts';

// Each owner module must register exactly the tool names the shared constants list (others only mention them).
const home = await mkdtemp(join(tmpdir(), 'tool-names-'));
process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
process.env.HOME = process.env.USERPROFILE = home;

function registeredTools(extension) {
  const tools = new Set();
  const noop = () => undefined;
  const pi = new Proxy({}, {
    get: (_t, key) => key === 'registerTool' ? tool => tools.add(tool.name)
      : key === 'getActiveTools' || key === 'getAllTools' ? () => []
      : key === 'events' ? { on: noop, emit: noop } : noop,
  });
  return Promise.resolve(extension(pi)).then(() => tools);
}
const load = async path => (await import(path)).default;

test('Shell registers the shell and shell-job tools named by the constants', async () => {
  const names = await registeredTools(await load('../../modules/shell-tools/src/index.ts'));
  for (const name of [...SHELL_TOOLS.slice(0, 1), ...SHELL_JOB_TOOLS]) assert.ok(names.has(name), name);
  for (const name of names) assert.ok([...SHELL_TOOLS, ...SHELL_JOB_TOOLS].includes(name), `unlisted Shell tool ${name}`);
});

test('Subagents registers exactly SUBAGENT_TOOLS', async () => {
  const names = await registeredTools(await load('../../modules/subagents/src/index.ts'));
  assert.deepEqual([...names].sort(), [...SUBAGENT_TOOLS].sort());
});

test('Fork registers exactly FORK_TOOLS', async () => {
  const names = await registeredTools(await load('../../modules/fork/src/index.ts'));
  assert.deepEqual([...names].sort(), [...FORK_TOOLS].sort());
});

test('Monitor registers exactly MONITOR_TOOLS', async () => {
  const names = await registeredTools(await load('../../modules/monitor/src/index.ts'));
  assert.deepEqual([...names].sort(), [...MONITOR_TOOLS].sort());
});

test.after(() => rm(home, { recursive: true, force: true }));
