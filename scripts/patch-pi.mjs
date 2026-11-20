// 對 node_modules 內的 Pi 打補丁：createSessionId 由 uuidv7 改為 ULID（大寫）。
// 用法：node scripts/patch-pi.mjs [apply|check]；apply 為預設，冪等。
// 以內容比對而非檔名定位（bundle chunk 檔名帶雜湊，升版會變）。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGINAL = /function createSessionId\(\)\s*\{\s*return uuidv7\(\);?\s*\}/;
const PATCHED_BODY = 'function createSessionId(){return __piUlid().toUpperCase()}';
const IMPORT_LINE = 'import{ulid as __piUlid}from"ulid";';

export const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function targetFiles(root) {
  const base = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
  const files = [join(base, 'core', 'session-manager.js')];
  const chunks = join(base, 'bundle', 'chunks');
  if (existsSync(chunks)) for (const name of readdirSync(chunks)) if (name.endsWith('.js')) files.push(join(chunks, name));
  return files.filter(existsSync);
}

/** 回傳 [{ file, state: 'patched' | 'unpatched' }]；只列含 createSessionId 的檔案。 */
export function scan(root = defaultRoot) {
  const result = [];
  for (const file of targetFiles(root)) {
    const text = readFileSync(file, 'utf8');
    if (text.includes(PATCHED_BODY)) result.push({ file, state: 'patched' });
    else if (ORIGINAL.test(text)) result.push({ file, state: 'unpatched' });
    else if (text.includes('createSessionId')) result.push({ file, state: 'unknown' });
  }
  return result;
}

export function apply(root = defaultRoot) {
  const entries = scan(root);
  for (const entry of entries) {
    if (entry.state !== 'unpatched') continue;
    const text = readFileSync(entry.file, 'utf8');
    writeFileSync(entry.file, IMPORT_LINE + text.replace(ORIGINAL, PATCHED_BODY));
    entry.state = 'patched';
  }
  return entries;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = process.argv[2] === 'check' ? scan() : apply();
  for (const e of entries) console.log(`${e.state}: ${e.file}`);
  if (!entries.length || entries.some(e => e.state !== 'patched')) process.exit(1);
}
