import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ulid } from "ulid";

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_DELAYS_MS = [20, 40, 60, 80, 120, 200, 300, 500];

/** Windows may briefly lock the target (antivirus, indexers); retry transient rename failures with backoff. */
export async function renameWithRetry(from: string, to: string, operations = {
  rename,
  sleep: (ms: number) => new Promise<void>(done => setTimeout(done, ms)),
}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await operations.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_DELAYS_MS.length || !code || !RENAME_RETRY_CODES.has(code)) throw error;
      await operations.sleep(RENAME_DELAYS_MS[attempt]);
    }
  }
}

/** Write `data` as 2-space JSON plus a trailing newline. The old file survives any failure (temp file + rename). */
export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${ulid().toUpperCase()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await renameWithRetry(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Write one compact JSON line to the real stdout stream.
 *
 * In print mode the host redirects `process.stdout.write` to stderr, so the stream's own prototype
 * method is used. The callback fires only after the chunk is flushed, which keeps pipe backpressure intact.
 */
export function writeJsonStdout(data: unknown): Promise<void> {
  const write = Object.getPrototypeOf(process.stdout).write as (this: NodeJS.WriteStream, chunk: string, encoding: BufferEncoding, callback: (error?: Error | null) => void) => boolean;
  return new Promise((resolve, reject) => {
    write.call(process.stdout, `${JSON.stringify(data)}\n`, "utf8", (error) => (error ? reject(error) : resolve()));
  });
}
