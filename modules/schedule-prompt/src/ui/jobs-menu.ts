/**
 * Dialog-based Jobs management for hosts without TUI components (RPC and other non-TUI modes).
 *
 * `ctx.ui.custom()` returns undefined there, so the hotkey-driven JobsView cannot be used. This menu offers the same
 * actions (list, add, toggle, remove, cleanup) through select/confirm dialogs, which the RPC UI protocol supports.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CronScheduler } from "../scheduler.js";
import { deadlineLabel, validateJobDeadline } from "../deadline.js";
import type { ScheduleSettings } from "../settings.js";
import type { CronStorage } from "../storage.js";
import type { CronJob } from "../types.js";
import { runAddFlow } from "./add-flow.js";

const ADD = "Add job";
const CLEANUP = "Cleanup disabled jobs";
const BACK = "Back";

function describe(job: CronJob, scheduler: CronScheduler): string {
  const next = scheduler.getNextRun(job.id, job);
  const parts = [job.enabled ? "[on]" : "[off]", job.name, `${job.type} ${job.schedule}`];
  if (next) parts.push(`next ${next.toISOString()}`);
  if (job.endAt !== undefined) parts.push(deadlineLabel(job.endAt));
  parts.push(`runs ${job.runCount ?? 0}`);
  return `${parts.join(" | ")} (${job.id})`;
}

export async function runJobsMenu(
  ctx: ExtensionCommandContext,
  storage: CronStorage,
  scheduler: CronScheduler,
  settings: ScheduleSettings,
  mySessionId: string | undefined,
): Promise<void> {
  for (;;) {
    const mine = storage.getAllJobs().filter((j) => CronScheduler.isLoadedFor(j, mySessionId));
    const labelToJob = new Map(mine.map((j) => [describe(j, scheduler), j] as const));
    const disabled = mine.filter((j) => !j.enabled);
    const options = [...labelToJob.keys(), ADD, ...(disabled.length > 0 ? [CLEANUP] : []), BACK];
    const title = mine.length === 0 ? "Jobs (no scheduled prompts)" : `Jobs (${mine.length})`;
    const choice = await ctx.ui.select(title, options);
    if (!choice || choice === BACK) return;

    if (choice === ADD) {
      await runAddFlow(ctx, storage, scheduler, settings, mySessionId);
      continue;
    }
    if (choice === CLEANUP) {
      if (await ctx.ui.confirm("Cleanup", `Remove ${disabled.length} disabled job(s) in this session?`)) {
        for (const j of disabled) {
          storage.removeJob(j.id);
          scheduler.removeJob(j.id);
        }
      }
      continue;
    }

    const selected = labelToJob.get(choice);
    if (!selected) continue;
    const fresh = storage.getJob(selected.id);
    if (!fresh || !CronScheduler.isLoadedFor(fresh, mySessionId)) continue;
    const toggle = fresh.enabled ? "Disable" : "Enable";
    const action = await ctx.ui.select(fresh.name, [toggle, "Remove", BACK]);
    if (action === toggle) {
      const enabled = !fresh.enabled;
      try {
        if (enabled) validateJobDeadline(fresh);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        continue;
      }
      storage.updateJob(fresh.id, { enabled });
      scheduler.updateJob(fresh.id, { ...fresh, enabled });
    } else if (action === "Remove") {
      if (await ctx.ui.confirm("Remove", `Remove "${fresh.name}"?`)) {
        storage.removeJob(fresh.id);
        scheduler.removeJob(fresh.id);
      }
    }
  }
}
