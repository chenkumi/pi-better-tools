import { statSync } from 'node:fs';
import { scanLines } from './lines.ts';

/** Entries are serialised as {"type":…,"id":…,"parentId":…,…}, so the tree links can be read without parsing a huge line. */
const HEAD = /^\{"type":"[a-z_]+","id":"([^"]+)","parentId":(?:null|"([^"]*)")/;
const PARSE_LIMIT = 1024 * 1024;

const cache = new Map<string, Set<string> | undefined>();

/**
 * Ids on the path from the leaf back to the root. A session file keeps every branch, so lines of abandoned branches sit next to
 * the live ones; this tells them apart. The leaf is the given id, else the last entry of the file. Returns undefined (meaning
 * "do not filter") when the links cannot be followed completely, so a gap never hides real history.
 */
export async function currentBranchIds(file: string, leafId?: string): Promise<Set<string> | undefined> {
  let key: string;
  try { const stat = statSync(file); key = `${file}|${stat.size}|${stat.mtimeMs}|${leafId ?? ''}`; } catch { return undefined; }
  if (cache.has(key)) return cache.get(key);
  const parents = new Map<string, string | null>();
  let last: string | undefined;
  for await (const item of scanLines(file, 2)) {
    if (item.text === undefined) continue;
    const match = HEAD.exec(item.text.slice(0, 400));
    let id: string | undefined, parent: string | null | undefined;
    if (match) { id = match[1]; parent = match[2] ?? null; }
    else if (item.bytes <= PARSE_LIMIT) {
      try { const entry = JSON.parse(item.text) as { id?: unknown; parentId?: unknown }; if (typeof entry.id === 'string') { id = entry.id; parent = typeof entry.parentId === 'string' ? entry.parentId : null; } } catch { /* skip */ }
    }
    if (id !== undefined) { parents.set(id, parent ?? null); last = id; }
  }
  let result: Set<string> | undefined;
  const leaf = leafId && parents.has(leafId) ? leafId : last;
  if (leaf !== undefined) {
    const ids = new Set<string>();
    let cursor: string | null = leaf;
    while (cursor !== null) {
      if (ids.has(cursor)) { result = undefined; break; }
      if (!parents.has(cursor)) { ids.clear(); break; }
      ids.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    if (ids.size > 0) result = ids;
  }
  if (cache.size >= 4) cache.delete(cache.keys().next().value as string);
  cache.set(key, result);
  return result;
}
