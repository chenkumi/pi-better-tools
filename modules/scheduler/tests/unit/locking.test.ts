import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const lock = vi.fn();
vi.mock("proper-lockfile", () => ({ default: { lock: (...args: unknown[]) => lock(...args) } }));

import { acquireAdvisoryLock, withAdvisoryLock } from "../../src/locking.js";

const directories: string[] = [];
afterEach(async () => { lock.mockReset(); await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe("advisory lock", () => {
  it("always installs a non-throwing onCompromised handler (the library default throws into the host)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-lock-")); directories.push(directory);
    lock.mockResolvedValue(async () => undefined);
    await acquireAdvisoryLock(join(directory, "a.lock"));
    const options = lock.mock.calls[0][1] as { onCompromised: (error: Error) => void };
    expect(options.onCompromised).toBeTypeOf("function");
    expect(() => options.onCompromised(new Error("stale"))).not.toThrow();
  });

  it("forwards compromise to the owner and swallows owner exceptions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-lock-")); directories.push(directory);
    lock.mockResolvedValue(async () => undefined);
    const seen: string[] = [];
    await acquireAdvisoryLock(join(directory, "b.lock"), { onCompromised: (error) => { seen.push(error.message); throw new Error("owner bug"); } });
    const options = lock.mock.calls[0][1] as { onCompromised: (error: Error) => void };
    expect(() => options.onCompromised(new Error("lost"))).not.toThrow();
    expect(seen).toEqual(["lost"]);
  });

  it("returns the action result when release throws after the lock was compromised", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-lock-")); directories.push(directory);
    lock.mockResolvedValue(async () => { throw Object.assign(new Error("Lock is already released"), { code: "ERELEASED" }); });
    const result = await withAdvisoryLock(join(directory, "c.lock"), async () => {
      (lock.mock.calls[0][1] as { onCompromised: (error: Error) => void }).onCompromised(new Error("lost"));
      return "written";
    });
    expect(result).toBe("written");
  });

  it("still surfaces release errors when the lock was not compromised", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-lock-")); directories.push(directory);
    lock.mockResolvedValue(async () => { throw new Error("release failed"); });
    await expect(withAdvisoryLock(join(directory, "d.lock"), async () => "ok")).rejects.toThrow("release failed");
  });
});
