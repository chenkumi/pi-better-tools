import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RegistryStore, RevisionConflictError } from "../../src/registry-store.js";

const directories: string[] = [];
let lastDirectory = "";
async function makeStore(): Promise<RegistryStore> {
  const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-registry-"));
  directories.push(directory); lastDirectory = directory;
  let ticks = 0;
  return new RegistryStore({
    registryPath: join(directory, "registry.json"),
    lockPath: join(directory, "registry.lock"),
    now: () => `2026-09-17T00:00:0${ticks++}.000Z`,
  });
}
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const input = {
  id: "schedule-1",
  mode: "independent" as const,
  prompt: "hello",
  cwd: "C:/work",
  timing: { kind: "cron" as const, expression: "0 * * * *", timezone: "Asia/Taipei" },
};

describe("registry store", () => {
  it("creates, updates, and rejects stale optimistic revisions", async () => {
    const store = await makeStore();
    const created = await store.create(input, 0);
    expect(created.revision).toBe(1);
    const updated = await store.update(created.id, 1, { prompt: "updated", execution: { thinkingLevel: "high" } });
    expect(updated.revision).toBe(2);
    await expect(store.update(created.id, 1, { prompt: "stale" })).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it("serializes concurrent updates and preserves one conflict", async () => {
    const store = await makeStore();
    await store.create(input);
    const results = await Promise.allSettled([
      store.setState("schedule-1", 1, "paused"),
      store.setState("schedule-1", 1, "cancelled"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await store.list())[0].revision).toBe(2);
  });

  it("dedupes claims per occurrence slot", async () => {
    const store = await makeStore();
    await store.create(input);
    expect(await store.claim("schedule-1", 1, "r1", "2030-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z")).toBeDefined();
    // Same slot (e.g. a demoted host racing the new owner) and an older slot are both rejected.
    expect(await store.claim("schedule-1", 1, "r2", "2030-01-01T00:00:01.000Z", "2030-01-01T00:00:00.000Z")).toBeUndefined();
    expect(await store.claim("schedule-1", 1, "r3", "2030-01-01T00:00:02.000Z", "2029-12-31T23:59:00.000Z")).toBeUndefined();
    expect(await store.claim("schedule-1", 1, "r4", "2030-01-01T01:00:00.000Z", "2030-01-01T01:00:00.000Z")).toBeDefined();
    expect((await store.list())[0].lastRunId).toBe("r4");
  });

  it("does not resurrect deleted schedules and keeps update patches to whitelisted fields", async () => {
    const store = await makeStore();
    await store.create(input);
    await store.mutate(undefined, (registry) => { registry.schedules["schedule-1"].state = "deleted"; });
    const deleted = (await store.get()).schedules["schedule-1"];
    await expect(store.setState("schedule-1", deleted.revision, "active")).rejects.toThrow("deleted");
    expect((await store.get()).schedules["schedule-1"].state).toBe("deleted");

    const other = await store.create({ ...input, id: "schedule-2" });
    await expect(store.update(other.id, other.revision, { state: "deleted" } as never)).rejects.toThrow("active or paused");
    const hostile = { prompt: "ok", id: "evil", revision: 99, lastPlannedAt: "2099-01-01T00:00:00.000Z", createdAt: "x" } as never;
    const updated = await store.update(other.id, other.revision, hostile);
    expect(updated.id).toBe("schedule-2"); expect(updated.revision).toBe(other.revision + 1);
    expect(updated.lastPlannedAt).toBeUndefined(); expect(updated.createdAt).toBe(other.createdAt);
    await store.setState(other.id, updated.revision, "cancelled");
    const cancelled = (await store.get()).schedules["schedule-2"];
    await expect(store.update(other.id, cancelled.revision, { state: "active" })).rejects.toThrow("Cancelled");
  });

  it("rejects sub-minute cron cadence at creation", async () => {
    const store = await makeStore();
    await expect(store.create({ ...input, id: "fast", timing: { kind: "cron", expression: "*/10 * * * * *", timezone: "UTC" } })).rejects.toThrow("at least one minute");
  });

  it("fsyncs through a temp file that never lingers and keeps a backup of the previous registry", async () => {
    const store = await makeStore();
    await store.create(input);
    await store.update("schedule-1", 1, { prompt: "second" });
    const files = await readdir(lastDirectory);
    expect(files.filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(files).toContain("registry.json.bak");
  });
});
