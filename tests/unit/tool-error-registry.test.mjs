import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The code registry in shared/README.md ("Tool error codes") and the codes passed to `new ToolError(...)` in module
// source must be the same set: a new code needs a registry row, and a row whose code is gone must be removed.
const root = new URL('../../', import.meta.url);
const path = (...parts) => join(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...parts);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === 'test') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(?:ts|mjs)$/.test(entry.name)) yield full;
  }
}

function usedCodes() {
  const used = new Map();
  const dirs = readdirSync(path('modules')).map(name => path('modules', name));
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) {
      for (const [, code] of readFileSync(file, 'utf8').matchAll(/(?:new ToolError|codedText)\(\s*["']([A-Z][A-Z0-9_]*)["']/g)) {
        used.set(code, [...(used.get(code) ?? []), file]);
      }
    }
  }
  return used;
}

function registeredCodes() {
  const readme = readFileSync(path('shared', 'README.md'), 'utf8');
  const section = readme.split('## Tool error codes')[1];
  assert.ok(section, 'shared/README.md has a "Tool error codes" section');
  const rows = section.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Module') && !line.startsWith('|---'));
  return rows.flatMap(row => [...row.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(match => match[1]));
}

test('every ToolError code used in module source is registered in shared/README.md', () => {
  const registered = new Set(registeredCodes());
  const missing = [...usedCodes().keys()].filter(code => !registered.has(code)).sort();
  assert.deepEqual(missing, [], `register these codes in the shared/README.md table: ${missing.join(', ')}`);
});

test('every registered code is still used, and no code is registered twice', () => {
  const list = registeredCodes();
  assert.equal(new Set(list).size, list.length, 'a code appears in more than one registry row');
  const used = usedCodes();
  const stale = list.filter(code => !used.has(code)).sort();
  assert.deepEqual(stale, [], `registered but unused (remove the row entry): ${stale.join(', ')}`);
});

test('codes are prefixed with the owning module name', () => {
  const prefixes = { 'pty-terminal': 'PTY_', 'shell-tools': 'SHELL_', 'sqlite-tools': 'SQLITE_', monitor: 'MONITOR_', remote: 'REMOTE_' };
  for (const [code, files] of usedCodes()) {
    for (const file of files) {
      const module = Object.keys(prefixes).find(name => file.replace(/\\/g, '/').includes(`/modules/${name}/`));
      if (module) assert.ok(code.startsWith(prefixes[module]), `${code} in ${module} should start with ${prefixes[module]}`);
    }
  }
});
