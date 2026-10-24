// Cleanup may only call a pending file orphaned when its session is absent from every session directory Pi can use.
// Pi stores sessions in the default dir, in `sessionDir` from global or project settings (with `~` expanded by the home
// directory), in PI_CODING_AGENT_SESSION_DIR or in `--session-dir`; the running session's own directory is known too.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeOrphaned, findSessionDirs } from "../src/om/cleanup.ts";

let root: string;
let agentDir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "HOME", "USERPROFILE"];

const writeSession = (dir: string, id: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", id })}\n`);
};
const writePending = (id: string) => {
  const dir = join(agentDir, "pi-blackhole");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}-pending.json`), "{}");
};
const classify = (id: string, dirs?: string[]) => {
  const report = analyzeOrphaned(agentDir, dirs);
  return { orphaned: report.orphaned.some((f) => f.sessionId === id), active: report.active.some((f) => f.sessionId === id) };
};

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), "bh-cleanup-dirs-"));
  agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  rmSync(root, { recursive: true, force: true });
});

describe("session directories that cleanup must search before declaring a pending file orphaned", () => {
  it("control: a session in the default sessions dir is active", () => {
    writeSession(join(agentDir, "sessions", "--p--"), "S-DEFAULT"); writePending("S-DEFAULT");
    expect(classify("S-DEFAULT")).toEqual({ orphaned: false, active: true });
  });

  it("PI_CODING_AGENT_SESSION_DIR", () => {
    const external = join(root, "external");
    writeSession(external, "S-ENV"); writePending("S-ENV");
    process.env.PI_CODING_AGENT_SESSION_DIR = external;
    expect(findSessionDirs()).toContain(resolve(external));
    expect(classify("S-ENV")).toEqual({ orphaned: false, active: true });
  });

  it("--session-dir (both spellings)", () => {
    const a = join(root, "cli-a"), b = join(root, "cli-b");
    expect(findSessionDirs({ argv: ["--session-dir", a] })).toContain(resolve(a));
    expect(findSessionDirs({ argv: [`--session-dir=${b}`] })).toContain(resolve(b));
  });

  it("the running session's own directory and the project's settings sessionDir", () => {
    const own = join(root, "own"), project = join(root, "project-sessions"), cwd = join(root, "work");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: project }));
    const dirs = findSessionDirs({ currentSessionDir: own, cwd });
    expect(dirs).toContain(resolve(own)); expect(dirs).toContain(resolve(project));
  });

  it("`~` in the global settings sessionDir is expanded with the real home directory (Windows has no HOME)", () => {
    const fakeHome = join(root, "home");
    mkdirSync(fakeHome, { recursive: true });
    delete process.env.HOME; process.env.USERPROFILE = fakeHome;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/pi-sessions" }));
    expect(findSessionDirs()).toContain(resolve(homedir(), "pi-sessions"));
    if (process.platform === "win32") expect(findSessionDirs()).not.toContain(resolve("/home", "pi-sessions"));
  });
});
