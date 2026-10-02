import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolDebugLogger } from "../../src/tool-debug-log.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "pi-scheduler-debug-log-")); homes.push(home);
  const agent = join(home, ".pi", "agent"), logs = join(home, ".pi", "logs", "pi-scheduler");
  await mkdir(agent, { recursive: true });
  const settings = (text: string) => writeFile(join(agent, "settings.json"), text);
  return { home, logs, settings, logger: new ToolDebugLogger(home) };
}
async function records(logs: string) {
  const names = await readdir(logs);
  return Promise.all(names.map(async (name) => ({ name, record: JSON.parse(await readFile(join(logs, name), "utf8")) })));
}

describe("opt-in tool failure diagnostics", () => {
  it.each([
    undefined, "{", "null", "[]", "{}", '{"pi-scheduler":null}',
    '{"pi-scheduler":{"debugLog":false}}', '{"pi-scheduler":{"debugLog":"true"}}',
    '{"pi-scheduler":{"debugLog":1}}', '{"pi-schedular":{"debugLog":true}}',
  ])("does not create logs for missing/invalid/disabled or misspelled settings: %s", async (text) => {
    const f = await setup(); if (text !== undefined) await f.settings(text);
    await expect(f.logger.logFailure("schedule_status", "call-1", new Error("fixture"))).resolves.toBeUndefined();
    await expect(readdir(f.logs)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records canonical project, timestamp, correlation, and bounded error/stack", async () => {
    const f = await setup(); await f.settings('{"pi-scheduler":{"debugLog":true}}');
    const error = new Error("x".repeat(6000)); error.stack = "trace".repeat(5000);
    await f.logger.logFailure("schedule_update", "correlation-id", error);
    const [entry] = await records(f.logs);
    expect(entry.name).toMatch(/^\d{4}-\d{2}-\d{2}T.+-[0-9a-z]{26}\.log$/u);
    expect(entry.record).toMatchObject({ schemaVersion: 1, project: "pi-scheduler", toolName: "schedule_update", toolCallId: "correlation-id", pid: process.pid,
      error: { name: "Error", message: "x".repeat(4096), stack: "trace".repeat(5000).slice(0, 16_384) } });
    expect(new Date(entry.record.timestamp).toISOString()).toBe(entry.record.timestamp);
  });

  it("re-reads settings for each failure without recreating the logger", async () => {
    const f = await setup(); await f.settings('{"pi-scheduler":{"debugLog":true}}');
    await f.logger.logFailure("schedule_status", "first", "plain failure");
    await f.settings('{"pi-scheduler":{"debugLog":false}}');
    await f.logger.logFailure("schedule_status", "disabled", new Error("not logged"));
    expect(await records(f.logs)).toHaveLength(1);
    await f.settings('{"pi-scheduler":{"debugLog":true}}');
    await f.logger.logFailure("schedule_status", "last", undefined);
    const entries = await records(f.logs);
    expect(entries.map(({ record }) => record.toolCallId).sort()).toEqual(["first", "last"]);
    expect(entries.find(({ record }) => record.toolCallId === "first")?.record.error).toEqual({ name: "NonError", message: "plain failure" });
  });

  it("does not overwrite concurrent failures", async () => {
    const f = await setup(); await f.settings('{"pi-scheduler":{"debugLog":true}}');
    await Promise.all(Array.from({ length: 16 }, (_, i) => f.logger.logFailure("schedule_create", `call-${i}`, new Error(`failure-${i}`))));
    const entries = await records(f.logs); expect(entries).toHaveLength(16);
    expect(new Set(entries.map(({ record }) => record.toolCallId)).size).toBe(16);
  });

  it("tolerates settings and log filesystem failures without throwing", async () => {
    const f = await setup(); await rm(join(f.home, ".pi", "agent", "settings.json"), { force: true });
    await mkdir(join(f.home, ".pi", "agent", "settings.json"));
    await expect(f.logger.logFailure("schedule_status", "read-fault", new Error("original"))).resolves.toBeUndefined();
    await rm(join(f.home, ".pi", "agent", "settings.json"), { recursive: true });
    await f.settings('{"pi-scheduler":{"debugLog":true}}');
    await writeFile(join(f.home, ".pi", "logs"), "block log directory");
    await expect(f.logger.logFailure("schedule_status", "write-fault", new Error("original"))).resolves.toBeUndefined();
    expect(await readFile(join(f.home, ".pi", "logs"), "utf8")).toBe("block log directory");
  });
});
