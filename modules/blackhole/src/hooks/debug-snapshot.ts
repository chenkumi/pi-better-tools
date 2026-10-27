import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const DEBUG_SNAPSHOT_FILE = "pi-blackhole-debug.json";

const currentUser = (): string => {
  try {
    return userInfo().username.replace(/[^\w.-]/g, "_") || "user";
  } catch {
    return "user";
  }
};

/** A per-user directory under the OS temp directory, so users sharing a temp root never share the snapshot. */
export const debugSnapshotDir = (base: string = tmpdir()): string => join(base, `pi-blackhole-${currentUser()}`);

/**
 * Writes the opt-in debug snapshot (it holds message and summary previews) into the OS temp directory and returns
 * its path, or undefined when it could not be written. Debugging must never affect compaction, so errors are not thrown.
 * On POSIX the directory is 0700 and the file 0600, and a directory that is a symlink or belongs to another user is
 * refused; Windows has no POSIX modes, so it relies on the per-user temp directory.
 */
export const writeDebugSnapshot = (data: Record<string, unknown>, base: string = tmpdir()): string | undefined => {
  try {
    const dir = debugSnapshotDir(base);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
    const file = join(dir, DEBUG_SNAPSHOT_FILE);
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    return file;
  } catch {
    return undefined;
  }
};
