import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { ulid } from "ulid";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Run } from "../../src/domain.js";
import { RunStore, truncateOutput } from "../../src/run-store.js";

const directories: string[] = [];
async function makeStore(maxHistory = 2): Promise<RunStore> {
  const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-runs-"));
  directories.push(directory);
  return new RunStore({ runsPath: join(directory, "runs.jsonl"), lockPath: join(directory, "runs.lock"), logsDir: join(directory, "logs"), maxHistory, maxOutputBytes: 8 });
}
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function run(id: string): Run {
  return { runId: id, scheduleId: "schedule-1", mode: "independent", status: "planned", plannedAt: "2026-09-17T00:00:00.000Z", events: [] };
}

describe("run store", () => {
  it("prunes canonical UUID logs with history while preserving live, orphaned and unrecognized files", async () => {
    const store = await makeStore(1); const old = ulid().toLowerCase(), live = ulid().toLowerCase(), orphan = ulid().toLowerCase(), recent = ulid().toLowerCase();
    await store.append({ ...run(old), status: "succeeded" }); const oldLog = await store.writeOutput(old, "stdout", "old");
    await store.append({ ...run(live), status: "running" }); const liveLog = await store.writeOutput(live, "stdout", "live");
    await store.append({ ...run(orphan), status: "orphaned" }); const orphanLog = await store.writeOutput(orphan, "stdout", "orphan");
    const logs = join(directories.at(-1)!, "logs"); await writeFile(join(logs, "operator-notes.txt"), "preserve");
    await store.append({ ...run(recent), status: "succeeded" });
    await expect(readFile(oldLog)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(liveLog, "utf8")).toBe("live"); expect(await readFile(orphanLog, "utf8")).toBe("orphan");
    expect(await readdir(logs)).toContain("operator-notes.txt"); expect(store.diagnostics().logCleanupError).toBeUndefined();
  });
  it("resolves completion against latest cancellation and tolerates a late cancel", async () => {
    const store = await makeStore();
    await store.append({ ...run("race"), status: "running" });
    await store.beginCancellation("race", "2030-01-01T00:00:00Z");
    const finished = await store.finish("race", "succeeded", "2030-01-01T00:00:01Z", { outputSummary: "done" });
    expect(finished.status).toBe("cancelled"); expect(finished.error).toBeUndefined();
    expect((await store.beginCancellation("race", "2030-01-01T00:00:02Z")).status).toBe("cancelled");
  });

  it("serializes concurrent finish and cancellation without an illegal transition", async () => {
    const store = await makeStore();
    await store.append({ ...run("race"), status: "running" });
    await Promise.all([store.finish("race", "succeeded", "2030-01-01T00:00:01Z"), store.beginCancellation("race", "2030-01-01T00:00:01Z")]);
    const finished = await store.finish("race", "succeeded", "2030-01-01T00:00:02Z");
    expect(["succeeded", "cancelled"]).toContain(finished.status); expect(finished.error).toBeUndefined();
  });
  it("retains bounded history and validates transitions", async () => {
    const store = await makeStore();
    await store.append({ ...run("1"), status: "succeeded" });
    await store.append(run("2"));
    await store.append(run("3"));
    expect((await store.list()).map((item) => item.runId)).toEqual(["2", "3"]);
    const queued = await store.transition("3", "queued", "2026-09-17T00:01:00.000Z");
    expect(queued.status).toBe("queued");
    await expect(store.transition("3", "succeeded", "2026-09-17T00:02:00.000Z")).rejects.toThrow("Illegal run transition");
  });

  it("never prunes live runs and records cancellation requests idempotently", async () => {
    const store = await makeStore(1);
    await store.append(run("live"));
    await store.append({ ...run("old"), status: "succeeded" });
    await store.append({ ...run("recent"), status: "succeeded" });
    expect((await store.list()).map((r) => r.runId)).toEqual(["live", "recent"]);
    await Promise.all([store.requestCancellation("live", "2030-01-01T00:00:00Z"), store.requestCancellation("live", "2030-01-01T00:00:00Z")]);
    expect((await store.list())[0].events).toHaveLength(1);
  });

  it("preserves orphan barriers beyond the history cap and prevents a cancelled queued spawn", async () => {
    const store = await makeStore(1);
    await store.append({ ...run("orphan"), status: "orphaned" });
    await store.append({ ...run("old"), status: "succeeded" });
    await store.append({ ...run("queued"), status: "queued" });
    expect((await store.list()).map((r) => r.runId)).toEqual(["orphan", "queued"]);
    await store.requestCancellation("queued", "2030-01-01T00:00:00Z");
    let started = false;
    const result = await store.startQueued("queued", "2030-01-01T00:00:00Z", () => { started = true; return undefined; });
    expect(started).toBe(false); expect(result.status).toBe("cancelled");
  });

  it("records request events and bounds stored output", async () => {
    const store = await makeStore();
    await store.append(run("1"));
    const withEvent = await store.appendEvent("1", { type: "abort_requested", at: "2026-09-17T00:01:00.000Z" });
    expect(withEvent.events[0].type).toBe("abort_requested");
    const path = await store.writeOutput("1", "stdout", "1234567890");
    expect(await readFile(path, "utf8")).toContain("[truncated]");
    expect(truncateOutput("short", 8)).toBe("short");
  });
});
