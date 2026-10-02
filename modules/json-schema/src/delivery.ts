import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ulid } from "ulid";

/** Write `data` as 2-space JSON plus a trailing newline. The old file survives any failure (temp file + rename). */
export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${ulid().toLowerCase()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporary, path);
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
