import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

const job = (id: string): CronJob => ({ id, name: id, schedule: "5m", prompt: "p", enabled: true, type: "interval", intervalMs: 300000, createdAt: "", runCount: 0 });

describe("CronStorage durability", () => {
  let cwd: string;
  let pi: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-schedule-storage-"));
    pi = join(cwd, ".pi");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("moves an unreadable store aside instead of letting the next save erase it", () => {
    mkdirSync(pi);
    writeFileSync(join(pi, "schedule-prompts.json"), '{"jobs":[{"id":"precious"');
    const storage = new CronStorage(cwd);
    expect(storage.getAllJobs()).toEqual([]);
    storage.addJob(job("new"));
    const backups = readdirSync(pi).filter((n) => n.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(pi, backups[0]), "utf-8")).toContain("precious");
    expect(storage.getAllJobs().map((j) => j.id)).toEqual(["new"]);
  });

  it("treats valid JSON without a jobs array as corrupt rather than throwing", () => {
    mkdirSync(pi);
    writeFileSync(join(pi, "schedule-prompts.json"), '{"version":1}');
    const storage = new CronStorage(cwd);
    expect(() => storage.addJob(job("a"))).not.toThrow();
    expect(storage.getAllJobs()).toHaveLength(1);
  });

  it("leaves no temp or lock files behind after mutations", () => {
    const storage = new CronStorage(cwd);
    for (let i = 0; i < 5; i++) storage.addJob(job(`j${i}`));
    storage.updateJob("j1", { enabled: false });
    storage.removeJob("j2");
    expect(readdirSync(pi).sort()).toEqual(["schedule-prompts.json"]);
    expect(storage.getAllJobs().map((j) => j.id)).toEqual(["j0", "j1", "j3", "j4"]);
  });

  it("does not steal an old lock whose owner may still be active", () => {
    mkdirSync(pi);
    const lock = join(pi, "schedule-prompts.json.lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const storage = new CronStorage(cwd);
    expect(() => storage.addJob(job("a"))).toThrow(/Cannot acquire scheduled prompts lock/);
    expect(storage.getAllJobs()).toEqual([]);
    expect(existsSync(lock)).toBe(true);
  });

  it("fails closed immediately without writing when a live peer holds the lock", () => {
    mkdirSync(pi);
    mkdirSync(join(pi, "schedule-prompts.json.lock")); // fresh mtime: looks held
    const storage = new CronStorage(cwd);
    expect(() => storage.addJob(job("a"))).toThrow(/Cannot acquire scheduled prompts lock/);
    expect(storage.getAllJobs()).toEqual([]);
    expect(readdirSync(pi)).toEqual(["schedule-prompts.json.lock"]);
  });
});
