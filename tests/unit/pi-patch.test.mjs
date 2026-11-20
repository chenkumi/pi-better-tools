import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply, scan } from '../../scripts/patch-pi.mjs';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const piEntry = '@earendil-works/pi-coding-agent';

function fixture(source) {
  const root = mkdtempSync(join(tmpdir(), 'pi-patch-'));
  const dir = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session-manager.js'), source);
  return root;
}

test('apply 把 uuidv7 改成 ULID 且冪等', () => {
  const root = fixture('import{uuidv7}from"x";\nfunction createSessionId() {\n    return uuidv7();\n}\n');
  assert.equal(scan(root)[0].state, 'unpatched');
  apply(root);
  apply(root);
  const [entry] = scan(root);
  assert.equal(entry.state, 'patched');
  assert.equal(readFileSync(entry.file, 'utf8').match(/__piUlid/g).length, 2); // import 別名 + 呼叫，重複 apply 不會再加
});

test('上游改寫 createSessionId 時回報 unknown（升版需重新檢視補丁）', () => {
  assert.equal(scan(fixture('function createSessionId() { return makeId(); }'))[0].state, 'unknown');
});

test('node_modules 內的 Pi 已套用補丁（未套用請執行 npm run pi:patch）', async () => {
  const entries = scan();
  assert.ok(entries.length >= 2, 'expected session-manager.js and the bundle chunk');
  for (const e of entries) assert.equal(e.state, 'patched', `${e.file} is ${e.state}; run: npm run pi:patch`);
  const { SessionManager } = await import(piEntry);
  assert.match(SessionManager.inMemory().getSessionId(), ULID);
});
