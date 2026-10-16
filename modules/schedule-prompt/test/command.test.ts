import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CommandApprovals, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_LENGTH, defaultCommandShell, isValidCommandTimeout, jobKindError, resolveCommandCwd,
} from "../src/command.js";
import { MAX_TIMEOUT_MS } from "../../shell-tools/src/timeout-ms.mjs";

describe("jobKindError", () => {
  it("accepts a plain prompt job and a plain command job", () => {
    expect(jobKindError({ prompt: "hello" })).toBeUndefined();
    expect(jobKindError({ command: "echo hi" })).toBeUndefined();
    expect(jobKindError({ command: "echo hi", shell: "bash", cwd: "sub", timeoutMs: 1000 })).toBeUndefined();
  });
  it("requires exactly one of prompt and command", () => {
    expect(jobKindError({})).toMatch(/exactly one/);
    expect(jobKindError({ prompt: "p", command: "c" })).toMatch(/exactly one/);
  });
  it("rejects command-only fields on a prompt job and prompt-only fields on a command job", () => {
    expect(jobKindError({ prompt: "p", shell: "bash" })).toMatch(/'shell' only apply to command jobs/);
    expect(jobKindError({ prompt: "p", cwd: "x", timeoutMs: 5 })).toMatch(/'cwd', 'timeoutMs'/);
    expect(jobKindError({ command: "c", model: "haiku" })).toMatch(/'model' only apply to prompt jobs/);
    expect(jobKindError({ command: "c", notify: false })).toMatch(/'notify'/);
    expect(jobKindError({ command: "c", extensions: true, skills: [] })).toMatch(/'extensions', 'skills'/);
  });
  it("validates command shape: blank, too long, shell, cwd and timeout", () => {
    expect(jobKindError({ command: "   " })).toMatch(/non-empty/);
    expect(jobKindError({ command: "x".repeat(MAX_COMMAND_LENGTH + 1) })).toMatch(/longer than/);
    expect(jobKindError({ command: "x".repeat(MAX_COMMAND_LENGTH) })).toBeUndefined();
    expect(jobKindError({ command: "c", shell: "zsh" as any })).toMatch(/'shell'/);
    expect(jobKindError({ command: "c", cwd: "" })).toMatch(/'cwd'/);
    expect(jobKindError({ command: "c", timeoutMs: 0 })).toMatch(/'timeoutMs'/);
    expect(jobKindError({ command: "c", timeoutMs: 1.5 })).toMatch(/'timeoutMs'/);
    expect(jobKindError({ command: "c", timeoutMs: MAX_TIMEOUT_MS + 1 })).toMatch(/'timeoutMs'/);
    expect(jobKindError({ command: "c", timeoutMs: MAX_TIMEOUT_MS })).toBeUndefined();
  });
});

describe("small helpers", () => {
  it("defaults to PowerShell on Windows and bash elsewhere", () => {
    expect(defaultCommandShell("win32")).toBe("powershell");
    expect(defaultCommandShell("linux")).toBe("bash");
    expect(defaultCommandShell("darwin")).toBe("bash");
  });
  it("accepts only safe positive integer timeouts up to the host maximum", () => {
    expect(isValidCommandTimeout(DEFAULT_COMMAND_TIMEOUT_MS)).toBe(true);
    for (const bad of [0, -1, NaN, Infinity, 2.5, "5", undefined, MAX_TIMEOUT_MS + 1]) expect(isValidCommandTimeout(bad)).toBe(false);
  });
});

describe("resolveCommandCwd", () => {
  let base: string;
  let project: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "pi-command-cwd-")));
    project = join(base, "proj");
    mkdirSync(join(project, "sub", "deep"), { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("defaults to the real project directory", () => {
    expect(resolveCommandCwd(project)).toEqual({ ok: true, cwd: project, outsideProject: false });
  });
  it("resolves relative paths against the project and treats them as inside", () => {
    expect(resolveCommandCwd(project, "sub/deep")).toEqual({ ok: true, cwd: join(project, "sub", "deep"), outsideProject: false });
    expect(resolveCommandCwd(project, ".")).toMatchObject({ ok: true, cwd: project, outsideProject: false });
  });
  it("accepts an absolute path inside the project", () => {
    expect(resolveCommandCwd(project, join(project, "sub"))).toMatchObject({ ok: true, outsideProject: false });
  });
  it("flags parents, siblings and unrelated directories as outside", () => {
    expect(resolveCommandCwd(project, "..")).toMatchObject({ ok: true, cwd: base, outsideProject: true });
    mkdirSync(join(base, "other"));
    expect(resolveCommandCwd(project, "../other")).toMatchObject({ ok: true, outsideProject: true });
    expect(resolveCommandCwd(project, tmpdir())).toMatchObject({ ok: true, outsideProject: true });
  });
  it("does not treat a sibling that shares the project name as a prefix as inside", () => {
    mkdirSync(join(base, "proj-evil"));
    expect(resolveCommandCwd(project, "../proj-evil")).toMatchObject({ ok: true, outsideProject: true });
  });
  it("classifies a directory whose name starts with two dots as inside", () => {
    mkdirSync(join(project, "..cache"));
    expect(resolveCommandCwd(project, "..cache")).toMatchObject({ ok: true, outsideProject: false });
  });
  it("rejects a missing path and a file", () => {
    expect(resolveCommandCwd(project, "nope")).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    writeFileSync(join(project, "file.txt"), "x");
    expect(resolveCommandCwd(project, "file.txt")).toMatchObject({ ok: false, error: expect.stringMatching(/not a directory/) });
  });
  it("fails when the project directory itself is gone", () => {
    expect(resolveCommandCwd(join(base, "missing"))).toMatchObject({ ok: false, error: expect.stringMatching(/Project directory/) });
  });
  it("sees through a link that points outside the project", (ctx) => {
    mkdirSync(join(base, "elsewhere"));
    try {
      symlinkSync(join(base, "elsewhere"), join(project, "link"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      ctx.skip(); // link creation not permitted here; the property is still covered by the real-path comparison above
    }
    expect(resolveCommandCwd(project, "link")).toMatchObject({ ok: true, cwd: join(base, "elsewhere"), outsideProject: true });
  });
  it("sees through a link that points back inside the project", (ctx) => {
    try {
      symlinkSync(join(project, "sub"), join(project, "alias"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      ctx.skip();
    }
    expect(resolveCommandCwd(project, "alias")).toMatchObject({ ok: true, cwd: join(project, "sub"), outsideProject: false });
  });
  it.runIf(process.platform === "win32")("matches the project case-insensitively on Windows", () => {
    expect(resolveCommandCwd(project, project.toUpperCase())).toMatchObject({ ok: true, outsideProject: false });
  });
});

describe("CommandApprovals", () => {
  it("approves exactly the command, shell and directory it was given", () => {
    const approvals = new CommandApprovals();
    expect(approvals.isApproved("echo 1", "bash", "/x")).toBe(false);
    approvals.approve("echo 1", "bash", "/x");
    expect(approvals.isApproved("echo 1", "bash", "/x")).toBe(true);
    expect(approvals.isApproved("echo 2", "bash", "/x")).toBe(false);
    expect(approvals.isApproved("echo 1", "powershell", "/x")).toBe(false);
    expect(approvals.isApproved("echo 1", "bash", "/y")).toBe(false);
    approvals.clear();
    expect(approvals.isApproved("echo 1", "bash", "/x")).toBe(false);
  });
  it("does not let field boundaries collide", () => {
    const approvals = new CommandApprovals();
    approvals.approve("a", "bash", "b/c");
    expect(approvals.isApproved("a\u0000bash", "bash", "b/c")).toBe(false);
    expect(approvals.isApproved("a", "bash", "b")).toBe(false);
  });
});
