import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hasRule } from '../src/fold/registry.ts';

const modulesDir = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Names that appear next to `name:` in tool-registering files but deliberately have no dedicated fold rule.
 * Adding a tool to this list is a decision: it will be folded by the generic fallback.
 */
const GENERIC_BY_DESIGN = new Set([
  // Blackhole's own tools: `recall` reads Blackhole memory, the others are worker-only tools that never reach the main agent.
  'recall', 'record_observations', 'record_reflections', 'drop_observations',
  // Not tools: deferred-tool namespaces and a provider stream event name that sit next to `name:` in the same files.
  'pty', 'remote', 'sqlite', 'provider_stream_event',
]);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'tests' || entry === 'test') continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|mjs)$/.test(entry) && !/\.test\./.test(entry) && !/\.d\.[mc]?ts$/.test(entry)) yield path;
  }
}

function literalToolNames(): Map<string, string> {
  const found = new Map<string, string>();
  for (const module of readdirSync(modulesDir)) {
    for (const sub of ['src', 'extensions']) {
      const root = join(modulesDir, module, sub);
      try { statSync(root); } catch { continue; }
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8');
        if (!/registerTool\(|defineTool\(/.test(text)) continue;
        for (const match of text.matchAll(/\bname:\s*["']([a-z][a-z0-9_]*)["']/g)) found.set(match[1]!, `${module}/${sub}`);
      }
    }
  }
  return found;
}

test('every tool registered under a literal name has a fold rule or is generic by design', () => {
  const missing = [...literalToolNames()].filter(([name]) => !hasRule(name) && !GENERIC_BY_DESIGN.has(name)).map(([name, where]) => `${name} (${where})`);
  assert.deepEqual(missing, [], 'add a fold rule in src/fold/rules, or list the tool in GENERIC_BY_DESIGN with the reason');
});

test('the scan still finds the tools it is meant to guard', () => {
  const found = literalToolNames();
  for (const name of ['read', 'bash', 'subagent', 'fork', 'pty_read', 'sqlite_query', 'web_fetch', 'remote_send']) assert.ok(found.has(name), `scan lost ${name}`);
});

test('GENERIC_BY_DESIGN does not hide tools that now have a rule', () => {
  assert.deepEqual([...GENERIC_BY_DESIGN].filter(hasRule), []);
});
