import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import test from 'node:test';

const srcDir = new URL('../src/', import.meta.url);
const areas = readdirSync(srcDir).filter(name => statSync(new URL(`${name}/`, srcDir)).isDirectory());

// Importing an area must not touch the host: it receives no `pi`, so it can only export. It also must not add globals.
test('every shared area has an index and importing it does not need a host', async () => {
  assert.ok(areas.length > 0);
  for (const area of areas) {
    const index = new URL(`${area}/index.ts`, srcDir);
    const before = Object.getOwnPropertySymbols(globalThis).length + Object.keys(globalThis).length;
    const loaded = await import(index.href);
    assert.ok(Object.keys(loaded).length > 0, `${area} exports something`);
    const after = Object.getOwnPropertySymbols(globalThis).length + Object.keys(globalThis).length;
    assert.equal(after, before, `${area} must not add globals on import`);
  }
});
