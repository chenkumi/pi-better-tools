import { lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_PREFIX = 'pi-subagent-';
const TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SWEEP_REMOVALS = 512;
/** A prompt or query-copy directory is named for its owning process, so the sweep never removes a live run's files whatever their age. */
export const promptDirectoryPrefix = () => `${TEMP_PREFIX}${process.pid}-`;
export const queryDirectoryPrefix = () => `${TEMP_PREFIX}query-${process.pid}-`;
/** Exactly the names mkdtemp makes from the prefixes above (or the older pid-less ones): other tools' directories are never touched. */
const OWNED_NAME = new RegExp(String.raw`^${TEMP_PREFIX}(?:query-)?(?:(\d+)-)?[A-Za-z0-9]{6}$`);
/** Windows can briefly hold a file (antivirus, a straggler child): retry the removal instead of leaving the directory. */
export const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
let swept = false;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function ownerAlive(name: string): boolean {
  const pid = Number.parseInt(OWNED_NAME.exec(name)?.[1] ?? '', 10);
  return Number.isInteger(pid) && pid > 0 && processAlive(pid);
}

/**
 * Best effort: removes prompt and query-copy directories that a killed process left in tmpdir and nothing touched for 24 hours,
 * unless the name carries the pid of a live process. Only names this module generates are considered; at most 512 are removed per sweep.
 * A reused pid keeps a stale directory (it is skipped, never wrongly removed). It never blocks or fails a run; only plain directories are removed.
 */
export async function sweepStaleTempDirectories(root = tmpdir(), now = Date.now()): Promise<void> {
  try {
    let removed = 0;
    for (const name of (await readdir(root)).filter(name => OWNED_NAME.test(name))) {
      if (removed >= MAX_SWEEP_REMOVALS) break;
      const path = join(root, name);
      try {
        const info = await lstat(path);
        if (info.isDirectory() && now - info.mtimeMs > TEMP_RETENTION_MS && !ownerAlive(name)) { await rm(path, REMOVE_OPTIONS); removed++; }
      } catch { /* another process may have removed it */ }
    }
  } catch { /* housekeeping only */ }
}

/** The sweep runs once per process, on the first session start. */
export function sweepStaleTempDirectoriesOnce(): void {
  if (swept) return;
  swept = true;
  void sweepStaleTempDirectories();
}
