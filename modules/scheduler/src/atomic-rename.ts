import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const DELAYS_MS = [10, 20, 40, 80, 160, 250, 250, 500, 500, 500, 500, 500, 500, 500]; // ~4.3s worst case, only paid while the file stays locked

/**
 * Atomic replace that tolerates Windows' transient sharing violations: renaming over a file that another
 * handle (a concurrent reader, antivirus scan) briefly has open fails with EPERM/EBUSY/EACCES. The rename
 * stays atomic; only a bounded number of retries are added, and the last error is rethrown unchanged.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !code || !TRANSIENT.has(code) || attempt >= DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, DELAYS_MS[attempt]));
    }
  }
}

/**
 * Durable atomic replace: write a temp file, fsync it, then rename over the target. The temp file is
 * removed if any step fails, so failures never leak `*.tmp-*` siblings.
 */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  let renamed = false;
  try {
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}
