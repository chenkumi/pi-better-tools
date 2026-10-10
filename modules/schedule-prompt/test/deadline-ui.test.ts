import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runAddFlow } from "../src/ui/add-flow.js";
import { JobsView } from "../src/ui/jobs-view.js";
import { CronWidget } from "../src/ui/cron-widget.js";
import type { CronJob } from "../src/types.js";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const END = "2030-01-01T01:00:00.000Z";
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function setup(seed: CronJob[] = []) {
  const jobs = new Map(seed.map((j) => [j.id, j]));
  const storage = {
    hasJobWithName: (name: string) => [...jobs.values()].some((j) => j.name === name),
    getJob: (id: string) => jobs.get(id), getAllJobs: () => [...jobs.values()],
    addJob: vi.fn((j: CronJob) => jobs.set(j.id, j)),
    updateJob: vi.fn((id: string, partial: Partial<CronJob>) => Object.assign(jobs.get(id)!, partial)),
  } as any;
  const scheduler = { addJob: vi.fn(), updateJob: vi.fn(), getNextRun: () => null } as any;
  const ctx = { ui: { input: vi.fn(), select: vi.fn(), confirm: vi.fn().mockResolvedValue(true), notify: vi.fn(), setWidget: vi.fn() }, mode: "tui" } as any;
  return { storage, scheduler, ctx };
}
const seed = (overrides: Partial<CronJob> = {}): CronJob => ({ id: "j", name: "demo", enabled: false, type: "interval", schedule: "5m", prompt: "p", createdAt: "", runCount: 0, endAt: END, ...overrides });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function configure(ctx: any, deadline: string, inputs: (string | undefined)[]) {
  ctx.ui.select.mockResolvedValueOnce("Interval (periodic)").mockResolvedValueOnce(deadline).mockResolvedValueOnce("Bind to this session — only this pi fires it");
  for (const input of inputs) ctx.ui.input.mockResolvedValueOnce(input);
}

describe("deadline UI", () => {
  it("keeps the explicit no-deadline path compatible", async () => {
    const { storage, scheduler, ctx } = setup();
    configure(ctx, "No deadline", ["new", "5m", "p"]);
    await runAddFlow(ctx, storage, scheduler, {}, "s");
    expect(storage.addJob).toHaveBeenCalledWith(expect.objectContaining({ name: "new", endAt: undefined, session: "s" }));
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Confirm", expect.stringContaining("No deadline"));
  });
  it("re-prompts empty/invalid deadlines and normalizes the accepted input", async () => {
    const { storage, scheduler, ctx } = setup();
    configure(ctx, "Specify deadline", ["new", "5m", "", "2030-02-30T01:00:00Z", "2030-01-01T09:00:00+08:00", "p"]);
    await runAddFlow(ctx, storage, scheduler, {}, "s");
    expect(storage.addJob).toHaveBeenCalledWith(expect.objectContaining({ endAt: END }));
    expect(ctx.ui.input).toHaveBeenCalledTimes(6);
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Confirm", expect.stringContaining(END));
  });
  it("cancelling deadline input doesn't silently choose no deadline", async () => {
    const { storage, scheduler, ctx } = setup();
    configure(ctx, "Specify deadline", ["new", "5m", undefined]);
    await runAddFlow(ctx, storage, scheduler, {}, "s");
    expect(storage.addJob).not.toHaveBeenCalled();
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });
  it("revalidates after a long confirmation and refuses an already-expired deadline", async () => {
    const { storage, scheduler, ctx } = setup();
    configure(ctx, "Specify deadline", ["new", "5m", END, "p"]);
    ctx.ui.confirm.mockImplementation(() => { vi.setSystemTime(Date.parse(END)); return true; });
    await runAddFlow(ctx, storage, scheduler, {}, "s");
    expect(storage.addJob).not.toHaveBeenCalled();
    expect(scheduler.addJob).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("expired"), "error");
  });
  it("toggle re-reads an expired deadline, refuses enable and shows a useful error", () => {
    const { storage, scheduler } = setup([seed()]);
    const render = vi.fn();
    const view = new JobsView(storage, scheduler, "s", async () => {}, theme, render, () => {});
    storage.updateJob("j", { endAt: new Date(NOW).toISOString() });
    storage.updateJob.mockClear();
    view.handleInput("t");
    expect(storage.updateJob).not.toHaveBeenCalled();
    expect(scheduler.updateJob).not.toHaveBeenCalled();
    expect(view.render(120).join("\n")).toContain("extend or clear");
    expect(render).toHaveBeenCalled();
  });
  it("foreign jobs remain read-only even with an expired deadline", () => {
    const { storage, scheduler } = setup([seed({ session: "foreign", endAt: new Date(NOW).toISOString() })]);
    const view = new JobsView(storage, scheduler, "s", async () => {}, theme, () => {}, () => {});
    view.handleInput("t");
    expect(storage.updateJob).not.toHaveBeenCalled();
    expect(view.render(120).join("\n")).toContain("(expired)");
  });
  it("deadline details and error lines fit narrow widths", () => {
    const { storage, scheduler } = setup([seed({ endAt: "bad" })]);
    const view = new JobsView(storage, scheduler, "s", async () => {}, theme, () => {}, () => {});
    view.handleInput("t");
    for (const width of [1, 2, 20, 50]) {
      const lines = view.render(width);
      // These are the two newly introduced lines; pre-existing overlay rows
      // keep their historical layout and are not rewritten in this feature.
      expect(visibleWidth(lines[3])).toBeLessThanOrEqual(width);
      expect(visibleWidth(lines.at(-3)!)).toBeLessThanOrEqual(width);
    }
  });
  it("widget displays deadlines/expiration and wraps to available columns", () => {
    const { storage, scheduler, ctx } = setup([seed({ enabled: false, endAt: new Date(NOW).toISOString() })]);
    const pi = { events: { on: () => () => {} } } as any;
    const widget = new CronWidget(storage, scheduler, pi, () => true, "s");
    try {
      widget.show(ctx);
      const component = ctx.ui.setWidget.mock.calls[0][1](null, theme);
      expect(component.render(100).join("\n")).toContain("(expired)");
      for (const width of [10, 20, 50]) {
        expect(component.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
      }
    } finally { widget.destroy(); }
  });
});
