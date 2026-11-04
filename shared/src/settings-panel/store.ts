import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Patch } from './schema.js';

export type RawState =
  | { state: 'missing'; raw: Record<string, unknown> }
  | { state: 'ok'; raw: Record<string, unknown> }
  | { state: 'invalid'; reason: string };

/** Reads the untouched JSON document (no defaults filled in). Reasons never include file contents. */
export function readRaw(path: string): RawState {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', raw: {} };
    return { state: 'invalid', reason: 'cannot read the file' };
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { state: 'invalid', reason: 'not valid JSON' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid', reason: 'not a JSON object' };
  return { state: 'ok', raw: value as Record<string, unknown> };
}

/** Applies patches to a copy. Unknown keys and untouched values are preserved; emptied parent objects are pruned. */
export function applyPatches(raw: Record<string, unknown>, patches: readonly Patch[]): Record<string, unknown> {
  const next = structuredClone(raw);
  for (const { path, value } of patches) {
    const trail: Record<string, unknown>[] = [next];
    for (const key of path.slice(0, -1)) {
      const parent = trail[trail.length - 1]!;
      const child = parent[key];
      if (child && typeof child === 'object' && !Array.isArray(child)) trail.push(child as Record<string, unknown>);
      else if (value === undefined) { trail.length = 0; break; }
      else { const created: Record<string, unknown> = {}; parent[key] = created; trail.push(created); }
    }
    if (!trail.length) continue;
    const last = path[path.length - 1]!;
    if (value === undefined) delete trail[trail.length - 1]![last]; else trail[trail.length - 1]![last] = value;
    for (let i = trail.length - 1; i > 0; i--) {
      if (Object.keys(trail[i]!).length) break;
      delete trail[i - 1]![path[i - 1]!];
    }
  }
  return next;
}

export function removeFile(path: string): void {
  try { rmSync(path, { force: true }); } catch (error) { throw new Error(`cannot write the configuration file (${(error as NodeJS.ErrnoException).code ?? 'error'})`); }
}

/** Temp file in the same directory, then rename. A failed write never leaves a partial config behind. */
export function writeJsonAtomic(path: string, value: unknown): void {
  if (!isAbsolute(path)) throw new Error('configuration path must be absolute');
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${Date.now().toString(36)}-${process.pid}.tmp`);
  try {
    // 0600: the file may hold an API key. Ignored on Windows, where the user profile ACL applies.
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw new Error(`cannot write the configuration file (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}
