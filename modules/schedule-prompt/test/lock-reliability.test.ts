import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

vi.mock("../src/subagent.js", () => ({ runSubagentOnce: vi.fn() }));

const CHILD = fileURLToPath(new URL("./fixtures/lock-child.ts", import.meta.url));
const job = (id: string, o: Partial<CronJob> = {}): CronJob =>
  ({ id, name: id, schedule: "5m", prompt: "p", enabled: true, type: "interval", intervalMs: 300000, createdAt: "", runCount: 0, ...o }) as CronJob;

let cwd: string;
let lock: string;
let children: ChildProcess[] = [];
const defaultWait = CronStorage.lockWaitMs;

function child(args: string[]): { proc: ChildProcess; done: Promise<{ code: number | null; out: string }> } {
  const proc = spawn(process.execPath, ["--import", "tsx", CHILD, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
    // Burst tests measure absorption, not the production bound: allow a generous wait so a loaded CI host cannot flake them.
    env: { ...process.env, LOCK_CHILD_WAIT_MS: "20000" },
  });
  children.push(proc);
  let out = "";
  proc.stdout!.on("data", (d) => { out += d; });
  return { proc, done: new Promise((resolve) => proc.once("exit", (code) => resolve({ code, out }))) };
}
async function until(predicate: () => boolean, label: string, limitMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > limitMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function holdLockInChild(): Promise<ReturnType<typeof child>> {
  const ready = join(cwd, "READY");
  const held = child(["hold", cwd, ready]);
  await until(() => fs.existsSync(ready), "child to hold the lock");
  return held;
}
const writeOwner = (owner: unknown) => {
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(join(lock, "owner"), typeof owner === "string" ? owner : JSON.stringify(owner));
};

beforeEach(() => {
  cwd = fs.mkdtempSync(join(tmpdir(), "pi-sp-lockrel-"));
  lock = join(cwd, ".pi", "schedule-prompts.json.lock");
  CronStorage.lockWaitMs = 1500;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  CronStorage.lockWaitMs = defaultWait;
  for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
    await new Promise((r) => proc.once("exit", r));
  }
  children = [];
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("SCH-01: short lock contention is absorbed", () => {
  it("waits for a live peer that releases shortly instead of failing immediately", async () => {
    // The peer is a real process holding the lock for 400 ms inside a locked mutation.
    const ready = join(cwd, "READY");
    const held = child(["hold", cwd, ready, "400"]);
    await until(() => fs.existsSync(ready), "peer to hold the lock");
    const storage = new CronStorage(cwd);
    storage.addJob(job("mine"));
    expect((await held.done).code).toBe(0);
    expect(storage.getAllJobs().map((j) => j.id).sort()).toEqual(["mine", "seed"]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("loses no write when several real processes mutate the same store at once", async () => {
    const runs = ["p1", "p2", "p3", "p4"].map((tag) => child(["add", cwd, tag, "10"]));
    const results = await Promise.all(runs.map((r) => r.done));
    expect(results.map((r) => r.out.trim())).toEqual(["OK", "OK", "OK", "OK"]);
    expect(new CronStorage(cwd).getAllJobs()).toHaveLength(40);
    expect(fs.existsSync(lock)).toBe(false);
  }, 60_000);

  it("still fails closed (with holder guidance, without file paths) once the bounded wait is exhausted by a live holder", () => {
    CronStorage.lockWaitMs = 0;
    writeOwner({ token: "t", pid: process.pid, host: hostname() });
    const storage = new CronStorage(cwd);
    expect(() => storage.addJob(job("a"))).toThrow(/Cannot acquire scheduled prompts lock.*held by pid/s);
    expect(() => storage.addJob(job("a"))).not.toThrow(/schedule-prompts|\.lock\b/);
    expect(fs.existsSync(join(lock, "owner"))).toBe(true);
    expect(storage.getAllJobs()).toEqual([]);
  });
});

describe("SCH-01: a lock failure never permanently disables a one-shot job", () => {
  const ctx = { cwd: "/tmp", isProjectTrusted: () => true, modelRegistry: {}, sessionManager: { getSessionId: () => "s" } } as any;
  const makePi = () => ({ sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }) as any;
  const holdLiveLock = () => writeOwner({ token: "peer", pid: process.pid, host: hostname() });

  it("retries the fire after contention clears and records success, not error", async () => {
    CronStorage.lockWaitMs = 0; // exhaust the in-storage wait immediately: the scheduler must cope itself
    vi.useFakeTimers();
    const storage = new CronStorage(cwd);
    const once = job("o", { type: "once", schedule: new Date(Date.now() + 1000).toISOString(), intervalMs: undefined });
    storage.addJob(once);
    const pi = makePi();
    const scheduler = new CronScheduler(storage, pi, ctx);
    scheduler.addJob(once);
    holdLiveLock();
    await vi.advanceTimersByTimeAsync(1100); // fire hits the held lock
    expect(storage.getJob("o")).toMatchObject({ enabled: true });
    expect(storage.getJob("o")?.lastStatus).not.toBe("error");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    fs.rmSync(lock, { recursive: true, force: true }); // contention clears
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(storage.getJob("o")).toMatchObject({ enabled: false, lastStatus: "success", runCount: 1 });
    scheduler.stop();
  });

  it("does not disable the job when contention clears right after the first failed write", async () => {
    CronStorage.lockWaitMs = 0;
    vi.useFakeTimers();
    const storage = new CronStorage(cwd);
    const once = job("o", { type: "once", schedule: new Date(Date.now() + 1000).toISOString(), intervalMs: undefined });
    storage.addJob(once);
    const pi = makePi();
    const scheduler = new CronScheduler(storage, pi, ctx);
    scheduler.addJob(once);
    holdLiveLock();
    // The peer releases as soon as the scheduler reports its first problem, so a follow-up write would succeed.
    const release = () => { fs.rmSync(lock, { recursive: true, force: true }); };
    vi.mocked(console.error).mockImplementation(release);
    vi.mocked(console.warn).mockImplementation(release);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(storage.getJob("o")).toMatchObject({ enabled: false, lastStatus: "success" });
    scheduler.stop();
  });
});

describe("SCH-02: a force-killed lock holder is recovered conservatively", () => {
  it("takes over a lock whose same-host owner process was killed, and logs it", async () => {
    const held = await holdLockInChild();
    expect(fs.existsSync(lock)).toBe(true);
    held.proc.kill("SIGKILL");
    await held.done;
    expect(fs.existsSync(lock)).toBe(true); // the crash left it behind
    const storage = new CronStorage(cwd);
    storage.addJob(job("after-crash"));
    expect(storage.getAllJobs().map((j) => j.id).sort()).toEqual(["after-crash", "seed"]);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(join(cwd, ".pi")).sort()).toEqual(["schedule-prompts.json"]);
    const logged = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join(" ");
    expect(logged).toMatch(/stale.*lock|took over/i);
  });

  it("lets concurrent waiters recover the same dead owner without ever holding the lock together", async () => {
    const held = await holdLockInChild();
    held.proc.kill("SIGKILL");
    await held.done;
    const runs = ["w1", "w2", "w3"].map((tag) => child(["add", cwd, tag, "5"]));
    const results = await Promise.all(runs.map((r) => r.done));
    expect(results.map((r) => r.out.trim())).toEqual(["OK", "OK", "OK"]);
    expect(new CronStorage(cwd).getAllJobs()).toHaveLength(1 + 15); // a lost update would mean two holders
    expect(fs.existsSync(lock)).toBe(false);
  }, 60_000);

  it("never takes over a lock whose owner is a live process on this host", () => {
    CronStorage.lockWaitMs = 0;
    writeOwner({ token: "live", pid: process.pid, host: hostname() });
    expect(() => new CronStorage(cwd).addJob(job("a"))).toThrow(/Cannot acquire scheduled prompts lock/);
    expect(fs.readFileSync(join(lock, "owner"), "utf8")).toContain('"live"');
  });

  it("never takes over a lock owned by another host, even when that pid does not exist here", () => {
    CronStorage.lockWaitMs = 0;
    writeOwner({ token: "far", pid: 2_000_000_000, host: `${hostname()}-elsewhere` });
    expect(() => new CronStorage(cwd).addJob(job("a"))).toThrow(/cannot verify liveness across hosts/);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("never takes over a legacy token-only or ownerless lock and tells the user how to repair it", () => {
    CronStorage.lockWaitMs = 0;
    writeOwner("1.legacytoken");
    expect(() => new CronStorage(cwd).addJob(job("a"))).toThrow(/ask the user to remove the stale scheduled prompts lock/i);
    expect(fs.readFileSync(join(lock, "owner"), "utf8")).toBe("1.legacytoken");
    fs.rmSync(join(lock, "owner"));
    expect(() => new CronStorage(cwd).addJob(job("a"))).toThrow(/Cannot acquire scheduled prompts lock/);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("does not remove a lock whose owner token changed during our hold (token-checked release)", () => {
    const storage = new CronStorage(cwd);
    storage.addJob(job("a"));
    storage.updateJobWith("a", () => {
      writeOwner({ token: "peer", pid: process.pid, host: hostname() });
      return {};
    });
    expect(fs.readFileSync(join(lock, "owner"), "utf8")).toContain('"peer"');
  });
});
