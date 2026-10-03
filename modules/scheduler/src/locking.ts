import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export interface LockOptions {
  staleMs?: number;
  retries?: number;
  /**
   * Called when the lock was lost (its mtime went stale after a sleep or event-loop stall, or the lock
   * directory vanished). proper-lockfile's default handler throws from a timer, which would crash the host,
   * so this callback is always installed and exceptions from it are swallowed. Owners must stop work and
   * demote themselves; the lock must be treated as released (do not call the release function).
   */
  onCompromised?: (error: Error) => void;
}

export async function acquireAdvisoryLock(path: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  await handle.close();
  return lockfile.lock(path, {
    realpath: false,
    stale: options.staleMs ?? 10_000,
    retries: options.retries ?? 3,
    onCompromised: (error: Error) => {
      try { options.onCompromised?.(error); } catch { /* never throw into the lock timer */ }
    },
  });
}

export async function withAdvisoryLock<T>(path: string, action: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const release = await acquireAdvisoryLock(path, options);
  try {
    return await action();
  } finally {
    await release();
  }
}
