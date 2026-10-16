import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAddFlow } from "../src/ui/add-flow.js";
import { runJobsMenu } from "../src/ui/jobs-menu.js";
import { renderScheduledMessage } from "../src/ui/message-renderer.js";
import { CronWidget } from "../src/ui/cron-widget.js";
import { JobsView } from "../src/ui/jobs-view.js";
import { defaultCommandShell } from "../src/command.js";
import type { CronJob } from "../src/types.js";

let base: string;
let project: string;
let outside: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pi-command-ui-")));
  project = join(base, "proj");
  outside = join(base, "outside");
  mkdirSync(join(project, "sub"), { recursive: true });
  mkdirSync(outside);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });

function setup(seed: CronJob[] = []) {
  const jobs = new Map(seed.map((j) => [j.id, j]));
  const storage = {
    hasJobWithName: (name: string) => [...jobs.values()].some((j) => j.name === name),
    getJob: (id: string) => jobs.get(id), getAllJobs: () => [...jobs.values()],
    addJob: vi.fn((j: CronJob) => jobs.set(j.id, j)),
    updateJob: vi.fn((id: string, partial: Partial<CronJob>) => Object.assign(jobs.get(id)!, partial)),
    removeJob: vi.fn(), removeDisabledJobs: vi.fn(() => []),
  } as any;
  const scheduler = { addJob: vi.fn(), updateJob: vi.fn(), removeJob: vi.fn(), getNextRun: () => null, approveCommand: vi.fn().mockReturnValue(true) } as any;
  const ctx = { cwd: project, mode: "tui", ui: { input: vi.fn(), select: vi.fn(), confirm: vi.fn().mockResolvedValue(true), notify: vi.fn() } } as any;
  return { storage, scheduler, ctx };
}
const SESSION = "Bind to this session — only this pi fires it";
/** type → deadline → shell → scope, then the inputs in flow order. */
function script(ctx: any, { inputs, shell = defaultCommandShell() }: { inputs: (string | undefined)[]; shell?: string }) {
  ctx.ui.select.mockResolvedValueOnce("Interval (periodic)").mockResolvedValueOnce("No deadline").mockResolvedValueOnce(shell).mockResolvedValueOnce(SESSION);
  for (const input of inputs) ctx.ui.input.mockResolvedValueOnce(input);
}

describe("add flow for a shell command job", () => {
  it("collects command, shell, directory and timeout, shows them in the confirmation and approves the job", async () => {
    const { storage, scheduler, ctx } = setup();
    script(ctx, { inputs: ["nightly", "5m", "npm test", "sub", "90000"], shell: "bash" });
    await runAddFlow(ctx, storage, scheduler, {}, "sess", "command");
    expect(storage.addJob).toHaveBeenCalledOnce();
    const job = storage.addJob.mock.calls[0][0] as CronJob;
    expect(job).toMatchObject({ name: "nightly", command: "npm test", shell: "bash", cwd: join(project, "sub"), timeoutMs: 90_000, session: "sess", type: "interval" });
    expect(job.prompt).toBeUndefined();
    expect(scheduler.approveCommand).toHaveBeenCalledWith(job);
    expect(scheduler.addJob).toHaveBeenCalledWith(job);
    const [, message] = ctx.ui.confirm.mock.calls[0];
    expect(message).toContain("Command: npm test");
    expect(message).toContain("Shell: bash");
    expect(message).toContain(`Directory: ${join(project, "sub")}`);
    expect(message).toContain("90000 ms");
    expect(message).toContain("Runs unattended");
    expect(message).not.toContain("OUTSIDE");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Created scheduled command"), "info");
  });

  it("keeps the defaults for an empty directory and timeout", async () => {
    const { storage, scheduler, ctx } = setup();
    script(ctx, { inputs: ["n", "5m", "echo hi", "", ""] });
    await runAddFlow(ctx, storage, scheduler, {}, "sess", "command");
    expect(storage.addJob.mock.calls[0][0]).toMatchObject({ command: "echo hi", cwd: undefined, timeoutMs: undefined, shell: defaultCommandShell() });
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("(project directory)");
  });

  it("re-prompts a missing directory and an invalid timeout, and flags a directory outside the project", async () => {
    const { storage, scheduler, ctx } = setup();
    script(ctx, { inputs: ["n", "5m", "echo hi", "missing", outside, "abc", "0", "-5", "1500"] });
    await runAddFlow(ctx, storage, scheduler, {}, "sess", "command");
    const hints = ctx.ui.input.mock.calls.map((call: any[]) => call[1] as string);
    expect(hints.some((h: string) => /does not exist/.test(h))).toBe(true);
    expect(hints.some((h: string) => /integer from 1 to/.test(h))).toBe(true);
    expect(storage.addJob.mock.calls[0][0]).toMatchObject({ cwd: outside, timeoutMs: 1500 });
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("OUTSIDE the project");
  });

  it("saves nothing and approves nothing when cancelled at any step", async () => {
    for (const inputs of [["n", "5m", undefined], ["n", "5m", "   "], ["n", "5m", "echo", undefined], ["n", "5m", "echo", "", undefined]]) {
      const { storage, scheduler, ctx } = setup();
      script(ctx, { inputs });
      await runAddFlow(ctx, storage, scheduler, {}, "sess", "command");
      expect(storage.addJob).not.toHaveBeenCalled();
      expect(scheduler.approveCommand).not.toHaveBeenCalled();
    }
    const { storage, scheduler, ctx } = setup();
    script(ctx, { inputs: ["n", "5m", "echo", "", ""] });
    ctx.ui.confirm.mockResolvedValue(false);
    await runAddFlow(ctx, storage, scheduler, {}, "sess", "command");
    expect(storage.addJob).not.toHaveBeenCalled();
    expect(scheduler.approveCommand).not.toHaveBeenCalled();
  });

  it("does not save when the directory disappears between the prompt and the approval", async () => {
    const { storage, scheduler, ctx } = setup();
    scheduler.approveCommand.mockReturnValue(false);
    script(ctx, { inputs: ["n", "5m", "echo", "sub", ""] });
    await runAddFlow(ctx, storage, scheduler, {}, "sess", "command");
    expect(storage.addJob).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/no longer available/), "error");
  });

  it("leaves the prompt flow untouched (no command questions, no approval)", async () => {
    const { storage, scheduler, ctx } = setup();
    ctx.ui.select.mockResolvedValueOnce("Interval (periodic)").mockResolvedValueOnce("No deadline").mockResolvedValueOnce(SESSION);
    for (const input of ["p", "5m", "hello"]) ctx.ui.input.mockResolvedValueOnce(input);
    await runAddFlow(ctx, storage, scheduler, {}, "sess");
    expect(storage.addJob.mock.calls[0][0]).toMatchObject({ prompt: "hello", command: undefined });
    expect(scheduler.approveCommand).not.toHaveBeenCalled();
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("Prompt: hello");
  });
});

describe("jobs menu", () => {
  const cmdJob = (over: Partial<CronJob> = {}): CronJob => ({ id: "cmdjob0001", name: "cmd", schedule: "5m", intervalMs: 300000, command: "echo hi", enabled: false, type: "interval", createdAt: "", runCount: 0, ...over });
  function drive(ctx: any, jobAction: string) {
    let first = true;
    ctx.ui.select.mockImplementation(async (title: string, options: string[]) => {
      if (title.startsWith("Jobs")) { if (first) { first = false; return options.find((o) => o.includes("cmdjob0001")); } return "Back"; }
      return jobAction;
    });
  }

  it("offers a shell command add entry that starts the command flow", async () => {
    const { storage, scheduler, ctx } = setup();
    ctx.ui.select.mockImplementation(async (_t: string, options: string[]) => { expect(options).toContain("Add shell command job"); return "Back"; });
    await runJobsMenu(ctx, storage, scheduler, {}, "sess");
    expect(ctx.ui.select).toHaveBeenCalled();
  });

  it("asks before enabling a command job, approves it, and leaves it disabled when declined", async () => {
    const { storage, scheduler, ctx } = setup([cmdJob({ cwd: outside })]);
    drive(ctx, "Enable");
    ctx.ui.confirm.mockResolvedValueOnce(false);
    await runJobsMenu(ctx, storage, scheduler, {}, undefined);
    expect(storage.getJob("cmdjob0001")?.enabled).toBe(false);
    expect(scheduler.approveCommand).not.toHaveBeenCalled();
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain(`Directory: ${outside}`);
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("Command: echo hi");

    drive(ctx, "Enable");
    await runJobsMenu(ctx, storage, scheduler, {}, undefined);
    expect(storage.getJob("cmdjob0001")?.enabled).toBe(true);
    expect(scheduler.approveCommand).toHaveBeenCalledOnce();
  });

  it("does not ask to enable an ordinary prompt job", async () => {
    const { storage, scheduler, ctx } = setup([{ ...cmdJob(), command: undefined, prompt: "p" }]);
    drive(ctx, "Enable");
    await runJobsMenu(ctx, storage, scheduler, {}, undefined);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(storage.getJob("cmdjob0001")?.enabled).toBe(true);
  });
});

describe("jobs overlay and widget", () => {
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
  const cmdJob = (over: Partial<CronJob> = {}): CronJob => ({ id: "cmdjob0001", name: "cmd", schedule: "5m", intervalMs: 300000, command: "echo hi", shell: "bash", cwd: "/work", enabled: false, type: "interval", createdAt: "", runCount: 0, ...over });

  it("lists a command job as `$ command`, shows its details, and the m key starts the command flow", () => {
    const { storage, scheduler } = setup([cmdJob()]);
    const runAdd = vi.fn().mockResolvedValue(undefined);
    const runAddCommand = vi.fn().mockResolvedValue(undefined);
    const view = new JobsView(storage, scheduler, undefined, runAdd, theme, () => {}, () => {}, runAddCommand);
    const text = stripAnsi(view.render(120).join("\n"));
    expect(text).toContain("$ echo hi");
    expect(text).toContain("Command (bash): echo hi");
    expect(text).toContain("Directory: /work");
    expect(text).not.toContain("Prompt:");
    view.handleInput("m");
    expect(runAddCommand).toHaveBeenCalledOnce();
    expect(runAdd).not.toHaveBeenCalled();
  });

  it("approves a command job when it is enabled from the overlay", () => {
    const { storage, scheduler } = setup([cmdJob()]);
    const view = new JobsView(storage, scheduler, undefined, vi.fn(), theme, () => {}, () => {});
    view.handleInput("t");
    expect(scheduler.approveCommand).toHaveBeenCalledOnce();
    expect(storage.getJob("cmdjob0001")?.enabled).toBe(true);
  });

  it("renders a command job in the widget as `$ command`", () => {
    const { storage, scheduler } = setup([cmdJob({ enabled: true })]);
    const pi = { events: { on: vi.fn(() => () => {}) } } as any;
    const widget = new CronWidget(storage, scheduler, pi, () => true, undefined);
    const ui = { setWidget: vi.fn() };
    widget.show({ ui, mode: "tui" } as any);
    const factory = ui.setWidget.mock.calls[0][1];
    const lines: string[] = factory({ requestRender: () => {} }, theme).render(120);
    widget.destroy();
    expect(stripAnsi(lines.join("\n"))).toContain("$ echo hi");
  });
});

describe("scheduled message renderer for command runs", () => {
  const backgrounds: Record<string, string> = { toolSuccessBg: "\x1b[48;5;22m", toolErrorBg: "\x1b[48;5;52m", toolPendingBg: "\x1b[48;5;58m" };
  const theme = { fg: (_: string, text: string) => text, getBgAnsi: (key: string) => backgrounds[key], bg: (key: string, text: string) => backgrounds[key] + text + "\x1b[49m" } as any;
  const show = (details: any, expanded = false) => {
    const component = renderScheduledMessage({ role: "custom", customType: "scheduled_prompt", content: "x", details } as any, { expanded, outputPad: 0 } as any, theme)!;
    return stripAnsi(component.render(100).join("\n"));
  };
  const common = { jobName: "nightly", jobId: "j1", command: "npm test", shell: "bash", cwd: "/work" };

  it.each([["command_start", "starting"], ["command_done", "finished"], ["command_error", "failed"]])("labels %s as %s", (mode, label) => {
    const text = show({ ...common, mode, output: "ok", error: "bad" });
    expect(text).toContain(`Scheduled ${label}: nightly`);
  });
  it("shows the command collapsed, and command, shell, directory and exit code expanded", () => {
    expect(show({ ...common, mode: "command_done", exitCode: 0, output: "ok" })).toContain("Expand for job ID, command and retained result");
    const expanded = show({ ...common, mode: "command_error", exitCode: 3, error: "Command exited with code 3" }, true);
    expect(expanded).toContain("Command (bash): npm test");
    expect(expanded).toContain("Directory: /work");
    expect(expanded).toContain("Exit code: 3");
    expect(expanded).toContain("Command exited with code 3");
  });
  it("strips terminal control sequences from command and output", () => {
    const text = show({ ...common, command: "echo \x1b]0;pwn\x07hi", mode: "command_done", output: "a\x1b[2Jb" }, true);
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\x07");
  });
});
