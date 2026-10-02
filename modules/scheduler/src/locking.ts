import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export interface LockOptions {
  staleMs?: number;
  retries?: number;
}

export async function acquireAdvisoryLock(path: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  await handle.close();
  return lockfile.lock(path, {
    realpath: false,
    stale: options.staleMs ?? 10_000,
    retries: options.retries ?? 3,
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
