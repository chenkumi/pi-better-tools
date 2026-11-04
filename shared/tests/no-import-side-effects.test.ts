import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import test from 'node:test';

const srcDir = new URL('../src/', import.meta.url);
const areas = readdirSync(srcDir).filter(name => statSync(new URL(`${name}/`, srcDir)).isDirectory());

// Importing an area must not touch the host: it receives no `pi`, so it can only export. It also must not create the
// project's cross-module registries (Symbol.for('pi-better-tools.*') or __pi* globals); those are created lazily on first use.
// Third-party libraries imported by an area may set their own globals, which is not checked here.
test('every shared area has an index and importing it does not need a host', async () => {
  assert.ok(areas.length > 0);
  for (const area of areas) {
    const index = new URL(`${area}/index.ts`, srcDir);
    const ours = () => [...Object.getOwnPropertySymbols(globalThis).filter(s => s.description?.startsWith('pi-better-tools')).map(String), ...Object.keys(globalThis).filter(k => k.startsWith('__pi'))];
    const before = ours();
    const loaded = await import(index.href);
    assert.ok(Object.keys(loaded).length > 0, `${area} exports something`);
    assert.deepEqual(ours(), before, `${area} must not create project registries on import`);
  }
});
