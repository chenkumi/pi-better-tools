import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { debugSnapshotDir, writeDebugSnapshot } from "./debug-snapshot.js";

const posix = process.platform !== "win32";
let base: string;
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("writeDebugSnapshot", () => {
  it("writes under the given temp base, never a fixed /tmp", () => {
    base = mkdtempSync(join(tmpdir(), "bh-snap-"));
    const file = writeDebugSnapshot({ a: 1 }, base);
    expect(file && dirname(dirname(file))).toBe(base);
    expect(JSON.parse(readFileSync(file!, "utf8"))).toEqual({ a: 1 });
  });

  it.runIf(posix)("keeps the snapshot private to the user", () => {
    base = mkdtempSync(join(tmpdir(), "bh-snap-"));
    const file = writeDebugSnapshot({ a: 1 }, base)!;
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(dirname(file)).mode & 0o077).toBe(0);
  });

  it.runIf(posix)("refuses a snapshot directory that is a symlink", () => {
    base = mkdtempSync(join(tmpdir(), "bh-snap-"));
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, debugSnapshotDir(base));
    expect(writeDebugSnapshot({ a: 1 }, base)).toBeUndefined();
  });

  it("returns undefined instead of throwing when the directory cannot be created", () => {
    base = mkdtempSync(join(tmpdir(), "bh-snap-"));
    expect(writeDebugSnapshot({ a: 1 }, join(base, "missing", "\0bad"))).toBeUndefined();
  });
});
