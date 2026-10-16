/**
 * Interactive add flow for `/schedule-prompt`.
 * Steps the user through name → type → schedule (with re-prompt on validation
 * failure) → deadline → prompt → scope → confirm. Saves and schedules the new job, or
 * returns silently on cancellation.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { CronScheduler } from "../scheduler.js";
import { deadlineLabel, normalizeEndAt, validateJobDeadline } from "../deadline.js";
import type { ScheduleSettings } from "../settings.js";
import type { CronStorage } from "../storage.js";
import type { CommandShell, CronJob } from "../types.js";
import { MAX_TIMEOUT_MS } from "../../../shell-tools/src/timeout-ms.mjs";
import { COMMAND_SHELLS, commandSpecLines, defaultCommandShell, isValidCommandTimeout, resolveCommandCwd } from "../command.js";

export async function runAddFlow(
  ctx: ExtensionCommandContext,
  storage: CronStorage,
  scheduler: CronScheduler,
  settings: ScheduleSettings,
  mySessionId: string | undefined,
  kind: "prompt" | "command" = "prompt",
): Promise<void> {
  const name = await ctx.ui.input("Job Name", "Enter a name for this scheduled prompt");
  if (!name) return;

  if (storage.hasJobWithName(name)) {
    ctx.ui.notify(`A job named "${name}" already exists`, "error");
    return;
  }

  const typeChoice = await ctx.ui.select("Job Type", [
    "Cron (recurring)",
    "Once (one-shot)",
    "Interval (periodic)",
  ]);
  if (!typeChoice) return;

  const typeMap: Record<string, "cron" | "once" | "interval"> = {
    "Cron (recurring)": "cron",
    "Once (one-shot)": "once",
    "Interval (periodic)": "interval",
  };
  const jobType = typeMap[typeChoice];

  const placeholders: Record<string, string> = {
    cron: "6-field cron, e.g. '0 0 9 * * *' for 9am daily",
    once: "ISO timestamp or relative time (+10s, +5m, +1h)",
    interval: "Duration, e.g. '5m', '1h', '30s'",
  };

  // Re-prompt the schedule field on validation failure so the user
  // doesn't lose name/type and have to start over from the menu.
  let schedule: string | undefined;
  let intervalMs: number | undefined;
  let placeholder = placeholders[jobType];
  while (true) {
    const raw = await ctx.ui.input("Schedule", placeholder);
    if (!raw) return;
    const result = CronScheduler.validateSchedule(jobType, raw.trim());
    if (result.ok) {
      schedule = result.schedule;
      intervalMs = result.intervalMs;
      break;
    }
    placeholder = result.error;
  }

  const deadlineChoice = await ctx.ui.select("Deadline", ["No deadline", "Specify deadline"]);
  if (!deadlineChoice) return;
  let endAt: string | undefined;
  if (deadlineChoice === "Specify deadline") {
    let hint = "ISO with seconds and timezone, e.g. YYYY-MM-DDTHH:mm:ssZ";
    while (true) {
      const raw = await ctx.ui.input("End At", hint);
      if (raw === undefined) return;
      try {
        endAt = normalizeEndAt(raw.trim());
        validateJobDeadline({ type: jobType, schedule, endAt });
        break;
      } catch (error) {
        hint = error instanceof Error ? error.message : String(error);
      }
    }
  }

  let prompt: string | undefined;
  let command: string | undefined;
  let shell: CommandShell | undefined;
  let cwd: string | undefined;
  let timeoutMs: number | undefined;
  if (kind === "command") {
    const rawCommand = await ctx.ui.input("Command", "Shell command to run on every trigger");
    if (!rawCommand || !rawCommand.trim()) return;
    command = rawCommand;
    const fallback = defaultCommandShell();
    const shellChoice = await ctx.ui.select("Shell", [fallback, ...COMMAND_SHELLS.filter((s) => s !== fallback)]);
    if (!shellChoice) return;
    shell = shellChoice as CommandShell;

    // Empty keeps the default (the project directory, not frozen); a given one is stored as its real path.
    let cwdHint = "Directory relative to the project (empty = project directory)";
    while (true) {
      const raw = await ctx.ui.input("Directory", cwdHint);
      if (raw === undefined) return;
      if (raw.trim() === "") break;
      const resolved = resolveCommandCwd(ctx.cwd, raw.trim());
      if (resolved.ok) { cwd = resolved.cwd; break; }
      cwdHint = resolved.error;
    }

    let timeoutHint = "Output-stall deadline in ms (empty = default 300000)";
    while (true) {
      const raw = await ctx.ui.input("Stall timeout (ms)", timeoutHint);
      if (raw === undefined) return;
      if (raw.trim() === "") break;
      const value = Number(raw.trim());
      if (/^\d+$/.test(raw.trim()) && isValidCommandTimeout(value)) { timeoutMs = value; break; }
      timeoutHint = `Must be an integer from 1 to ${MAX_TIMEOUT_MS}`;
    }
  } else {
    prompt = await ctx.ui.input("Prompt", "Enter the prompt to execute");
    if (!prompt) return;
  }

  // Last decision before save. Default option is listed first, picked up
  // from the global `defaultJobScope` setting — so hitting enter takes the
  // configured default.
  const defaultIsSession = (settings.defaultJobScope ?? "session") === "session";
  const SCOPE_SESSION = "Bind to this session — only this pi fires it";
  const SCOPE_SHARED = "Shared — every pi in this cwd fires it (accepts duplicate fires)";
  const scopeChoice = await ctx.ui.select(
    "Scope",
    defaultIsSession ? [SCOPE_SESSION, SCOPE_SHARED] : [SCOPE_SHARED, SCOPE_SESSION],
  );
  if (!scopeChoice) return;
  const session = scopeChoice === SCOPE_SESSION ? mySessionId : undefined;

  const human = CronScheduler.describeSchedule(jobType, schedule);
  const scopeLabel = session ? "session-bound" : "shared (any pi here)";
  const detail = command !== undefined
    ? commandSpecLines(ctx.cwd, { command, shell, cwd, timeoutMs }).join("\n")
    : `Prompt: ${prompt}`;
  const confirmed = await ctx.ui.confirm(
    command !== undefined ? "Confirm scheduled command" : "Confirm",
    `Save "${name}"?\nSchedule: ${human}\n${deadlineLabel(endAt)}\nScope: ${scopeLabel}\n${detail}`,
  );
  if (!confirmed) return;

  const job: CronJob = {
    id: nanoid(10),
    name,
    schedule,
    endAt,
    prompt,
    command,
    shell,
    cwd,
    timeoutMs,
    enabled: true,
    type: jobType,
    intervalMs,
    createdAt: new Date().toISOString(),
    runCount: 0,
    session,
  };

  try {
    validateJobDeadline(job);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  if (command !== undefined && !scheduler.approveCommand(job)) {
    ctx.ui.notify("The working directory is no longer available; nothing was saved.", "error");
    return;
  }
  storage.addJob(job);
  scheduler.addJob(job);
  ctx.ui.notify(`Created scheduled ${command !== undefined ? "command" : "prompt"}: ${name} (${human})`, "info");
}
