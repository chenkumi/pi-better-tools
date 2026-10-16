import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

const base = { schedule: "5m", enabled: true, type: "interval", intervalMs: 300000, createdAt: "", runCount: 0 };

describe("command jobs in the store", () => {
  let cwd: string;
  let file: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-schedule-command-storage-"));
    mkdirSync(join(cwd, ".pi"));
    file = join(cwd, ".pi", "schedule-prompts.json");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (jobs: unknown[]) => writeFileSync(file, JSON.stringify({ version: 1, jobs }));

  it("loads a command job that has no prompt and round-trips its fields", () => {
    write([{ ...base, id: "c1", name: "c1", command: "echo hi", shell: "bash", cwd: "/x", timeoutMs: 1000 }]);
    const storage = new CronStorage(cwd);
    expect(storage.getJob("c1")).toMatchObject({ command: "echo hi", shell: "bash", cwd: "/x", timeoutMs: 1000 });
    expect(storage.getJob("c1")?.prompt).toBeUndefined();
    storage.updateJob("c1", { lastStatus: "success" });
    const persisted = JSON.parse(readFileSync(file, "utf-8")).jobs[0];
    expect(persisted).toMatchObject({ command: "echo hi", shell: "bash", cwd: "/x", timeoutMs: 1000, lastStatus: "success" });
    expect("prompt" in persisted).toBe(false);
  });

  it("still loads ordinary prompt jobs (including legacy ones without any command field)", () => {
    write([{ ...base, id: "p1", name: "p1", prompt: "hello" }]);
    expect(new CronStorage(cwd).getJob("p1")?.prompt).toBe("hello");
  });

  it.each([
    ["neither prompt nor command", {}],
    ["both prompt and command", { prompt: "p", command: "c" }],
    ["a blank command", { command: "  " }],
    ["a non-string command", { command: 5 }],
    ["a non-string prompt", { prompt: 5 }],
    ["an unknown shell", { command: "c", shell: "zsh" }],
    ["a non-positive timeout", { command: "c", timeoutMs: 0 }],
    ["a fractional timeout", { command: "c", timeoutMs: 1.5 }],
    ["a model on a command job", { command: "c", model: "haiku" }],
    ["notify on a command job", { command: "c", notify: true }],
    ["a shell on a prompt job", { prompt: "p", shell: "bash" }],
    ["a cwd on a prompt job", { prompt: "p", cwd: "/x" }],
  ])("ignores a malformed entry: %s", (_label, extra) => {
    write([{ ...base, id: "bad", name: "bad", ...extra }, { ...base, id: "good", name: "good", prompt: "ok" }]);
    const storage = new CronStorage(cwd);
    expect(storage.getAllJobs().map((j: CronJob) => j.id)).toEqual(["good"]);
  });
});
