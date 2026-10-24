import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStorage } from "../src/storage.js";

const valid = { id: "ok", name: "ok", schedule: "5m", enabled: true, type: "interval", intervalMs: 300000, prompt: "keep", createdAt: "", runCount: 0 };

// load() ignores entries it cannot use; the next save() rewrites the whole file, which used to destroy those entries
// silently. They must survive in a side file before the rewrite.
describe("malformed job entries are preserved before a save rewrites the file", () => {
  let cwd: string;
  let file: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-schedule-malformed-"));
    mkdirSync(join(cwd, ".pi"));
    file = join(cwd, ".pi", "schedule-prompts.json");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));
  const sideFiles = () => readdirSync(join(cwd, ".pi")).filter((name) => name.startsWith("schedule-prompts.json.malformed-"));

  it("keeps the original file in a side file, then rewrites without the bad entry", () => {
    const hand = { id: "typo", name: "typo", schedule: "5m", prompt: "hand-edited, forgot the type", enabled: "yes" };
    writeFileSync(file, JSON.stringify({ version: 1, jobs: [valid, hand] }, null, 2));
    const storage = new CronStorage(cwd);
    expect(storage.getJob("ok")).toBeDefined();
    expect(sideFiles()).toEqual([]); // reading alone changes nothing on disk
    storage.updateJob("ok", { lastStatus: "success" });
    expect(sideFiles()).toHaveLength(1);
    const backup = JSON.parse(readFileSync(join(cwd, ".pi", sideFiles()[0]!), "utf-8"));
    expect(backup.jobs.map((job: { id: string }) => job.id)).toEqual(["ok", "typo"]);
    expect(JSON.parse(readFileSync(file, "utf-8")).jobs.map((job: { id: string }) => job.id)).toEqual(["ok"]);
  });

  it("does not create a side file for a store without malformed entries, nor repeat it on later saves", () => {
    writeFileSync(file, JSON.stringify({ version: 1, jobs: [valid] }));
    const storage = new CronStorage(cwd);
    storage.updateJob("ok", { lastStatus: "success" });
    expect(sideFiles()).toEqual([]);

    writeFileSync(file, JSON.stringify({ version: 1, jobs: [valid, { id: "bad" }] }));
    const second = new CronStorage(cwd);
    second.updateJob("ok", { runCount: 1 });
    second.updateJob("ok", { runCount: 2 });
    expect(sideFiles()).toHaveLength(1);
    expect(existsSync(file)).toBe(true);
  });
});
