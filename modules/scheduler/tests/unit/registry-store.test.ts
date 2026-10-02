import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RegistryStore, RevisionConflictError } from "../../src/registry-store.js";

const directories: string[] = [];
async function makeStore(): Promise<RegistryStore> {
  const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-registry-"));
  directories.push(directory);
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
});
