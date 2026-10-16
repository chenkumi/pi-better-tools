import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { nanoid } from "nanoid";
import { CronScheduler } from "./scheduler.js";
import { commandLabel, commandSpecLines, defaultCommandShell, isValidCommandTimeout, jobKindError, resolveCommandCwd } from "./command.js";
import { deadlineLabel, normalizeEndAt, validateJobDeadline } from "./deadline.js";
import type { JobScope } from "./settings.js";
import type { CronStorage } from "./storage.js";
import type { CommandShell, CronJob, CronJobType, CronToolDetails, } from "./types.js";
import { CronToolParams } from "./types.js";

function entryText(entry: any): string {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (c?.type === "text" ? c.text ?? "" : "")).join("");
}

/**
 * True when the current model turn was started by this extension.
 *
 * Provenance comes from the persisted entries of the current branch (oldest-first), not a text heuristic:
 * - inline job: the scheduler appends a `custom_message` entry (customType "scheduled_prompt", no `mode`) and then
 *   delivers the prompt as the user message; the marker therefore sits after the previous user message and its
 *   `details.prompt` equals the text of the current (latest) user message;
 * - notifying child job: a `subagent_done`/`subagent_error` marker with `details.notify` triggers a turn with no
 *   user message, so such a marker after the latest user message marks the current turn.
 * Older scheduled runs behind a later user message never match, so they do not block unrelated turns.
 */
export function isInScheduledExecution(sessionManager: { getBranch?: () => any[]; getEntries?: () => any[] }): boolean {
  const branch = (sessionManager.getBranch ?? sessionManager.getEntries)?.call(sessionManager) ?? [];
  const isUser = (e: any) => e?.type === "message" && e.message?.role === "user";
  const isMarker = (e: any) => e?.type === "custom_message" && e.customType === "scheduled_prompt";
  let latest = -1;
  let previous = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (!isUser(branch[i])) continue;
    if (latest < 0) latest = i;
    else { previous = i; break; }
  }
  for (let i = latest + 1; i < branch.length; i++) {
    const e = branch[i];
    if (isMarker(e) && e.details?.notify === true && /^subagent_(done|error)$/.test(e.details?.mode ?? "")) return true;
  }
  if (latest < 0) return false;
  const prompt = entryText(branch[latest]);
  for (let i = previous + 1; i < branch.length; i++) {
    const e = branch[i];
    if (i !== latest && isMarker(e) && !e.details?.mode && typeof e.details?.prompt === "string" && e.details.prompt === prompt) return true;
  }
  return false;
}

/**
 * Create the schedule_prompt tool definition.
 * `getDefaultScope` is a getter so live setting toggles affect the next `add`.
 */
export function createCronTool(
  getStorage: () => CronStorage,
  getScheduler: () => CronScheduler,
  getDefaultScope: () => JobScope = () => "session",
): ToolDefinition<typeof CronToolParams, CronToolDetails> {
  return {
    name: "schedule_prompt",
    label: "Schedule Prompt",
    description:
      "IMPORTANT: For action='add', you MUST provide 'schedule' AND exactly one of 'prompt' (text delivered to the agent) or 'command' (a shell command run unattended on schedule; optional shell/cwd/timeoutMs; the user must confirm the exact command interactively, its output is shown in chat only and never sent to the model). Schedule prompts at times/intervals. Schedule formats: 6-field cron (with seconds: '0 * * * * *' = every minute), ISO timestamp, relative time (+10s, +5m, +1h), or interval (5m, 1h). Type defaults to 'cron', use 'once' for relative/ISO times. Actions: add (needs schedule+prompt or command), list, remove/enable/disable/update (need jobId), cleanup. Optional endAt is an exclusive ISO deadline with timezone for new triggers, not a cancellation of running work; update with endAt:null clears it.",
    parameters: CronToolParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage();
      const scheduler = getScheduler();
      
      // Prevent recursive scheduling from within scheduled prompts
      if (params.action === "add" && isInScheduledExecution(ctx.sessionManager)) {
        throw new Error(
          "Cannot create scheduled prompts from within a scheduled prompt execution. This prevents infinite loops."
        );
      }

      const action = params.action;
      const details: CronToolDetails = {
        action,
        jobs: [],
      };

      try {
        switch (action) {
          case "add": {
            if (!params.schedule || (!params.prompt && !params.command)) {
              const missing = [];
              if (!params.schedule) missing.push("'schedule'");
              if (!params.prompt && !params.command) missing.push("'prompt' or 'command'");
              throw new Error(
                `Missing required parameters for add action: ${missing.join(" and ")}. You must provide schedule (e.g., '+10s', '*/5 * * * * *') and either prompt (the text to execute) or command (a shell command).`
              );
            }
            const kindError = jobKindError({
              prompt: params.prompt, command: params.command, shell: params.shell as CommandShell | undefined, cwd: params.cwd, timeoutMs: params.timeoutMs,
              model: params.model, notify: params.notify, extensions: params.extensions, skills: params.skills,
            });
            if (kindError) throw new Error(kindError);
            const isCommand = params.command !== undefined;
            if (isCommand && !(ctx.hasUI === true && typeof ctx.ui?.confirm === "function")) {
              throw new Error("Scheduling a shell command needs an interactive session so the user can confirm the exact command; nothing was saved.");
            }
            let commandCwd: string | undefined;
            if (isCommand && params.cwd !== undefined) {
              const resolved = resolveCommandCwd(ctx.cwd, params.cwd);
              if (!resolved.ok) throw new Error(resolved.error);
              commandCwd = resolved.cwd;
            }

            // Defense-in-depth — the schema also enforces this with minLength: 1,
            // but tool callers can bypass the schema by passing params directly.
            if (params.model !== undefined && params.model.length === 0) {
              throw new Error(
                "'model' must be a non-empty string. Omit the field for inline (no-model) jobs."
              );
            }

            // Generate name if not provided
            const jobName = params.name || `job-${nanoid(6)}`;

            // Check for duplicate names
            if (storage.hasJobWithName(jobName)) {
              throw new Error(
                `A job named "${jobName}" already exists. Please use a different name or remove the existing job first.`
              );
            }

            const type = (params.type || "cron") as CronJobType;
            const validated = CronScheduler.validateSchedule(type, params.schedule);
            if (!validated.ok) throw new Error(validated.error);
            const schedule = validated.schedule;
            const intervalMs = validated.intervalMs;

            if (params.endAt === null) throw new Error("endAt:null is only allowed on update; omit it on add for no deadline");
            const endAt = params.endAt === undefined ? undefined : normalizeEndAt(params.endAt);
            const now = new Date().toISOString();
            const session =
              getDefaultScope() === "session" ? ctx.sessionManager.getSessionId() : undefined;
            const job: CronJob = {
              id: nanoid(10),
              name: jobName,
              schedule,
              endAt,
              ...(isCommand ? { command: params.command, shell: params.shell as CommandShell | undefined, cwd: commandCwd, timeoutMs: params.timeoutMs } : { prompt: params.prompt }),
              enabled: true,
              type,
              intervalMs,
              createdAt: now,
              runCount: 0,
              description: params.description,
              model: params.model,
              notify: params.notify,
              extensions: params.extensions,
              skills: params.skills,
              session,
            };

            validateJobDeadline(job);
            if (isCommand) {
              const confirmed = await ctx.ui.confirm("Confirm scheduled command", [`Create "${job.name}" (${CronScheduler.describeSchedule(type, schedule)})?`, ...commandSpecLines(ctx.cwd, job)].join("\n"));
              if (!confirmed) throw new Error("The user did not confirm the scheduled command; nothing was saved.");
              if (!scheduler.approveCommand(job)) throw new Error("The working directory is no longer available; nothing was saved.");
            }
            storage.addJob(job);
            scheduler.addJob(job);
            details.jobs = [job];
            details.jobId = job.id;
            details.jobName = job.name;

            const modelLine = job.model
              ? `\nModel: ${job.model} (runs in subagent${job.notify ? ", notifies parent" : ""}${job.extensions ? ", extensions" : ""}${job.skills ? ", skills" : ""})`
              : "";
            return {
              content: [
                {
                  type: "text",
                  text: isCommand
                    ? `✓ Created command job "${job.name}" (${job.id})\nType: ${job.type}\nSchedule: ${job.schedule}\n${deadlineLabel(job.endAt)}\n${commandLabel(job)}\nDirectory: ${job.cwd ?? "(project directory)"}`
                    : `✓ Created cron job "${job.name}" (${job.id})\nType: ${job.type}\nSchedule: ${job.schedule}\n${deadlineLabel(job.endAt)}\nPrompt: ${job.prompt}${modelLine}`,
                },
              ],
              details,
            };
          }

          case "remove": {
            if (!params.jobId) {
              throw new Error("jobId is required for remove action");
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            const removed = storage.removeJob(params.jobId);
            if (removed) {
              scheduler.removeJob(params.jobId);
              details.jobId = params.jobId;
              details.jobName = job.name;

              return {
                content: [
                  {
                    type: "text",
                    text: `✓ Removed cron job "${job.name}" (${params.jobId})`,
                  },
                ],
                details,
              };
            }
            throw new Error(`Failed to remove job: ${params.jobId}`);
          }

          case "enable":
          case "disable": {
            if (!params.jobId) {
              throw new Error(`jobId is required for ${action} action`);
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            const enabled = action === "enable";
            if (enabled) validateJobDeadline(job);
            if (enabled && job.command !== undefined) {
              if (!(ctx.hasUI === true && typeof ctx.ui?.confirm === "function")) {
                throw new Error("Enabling a shell command job needs an interactive session so the user can confirm the exact command.");
              }
              const confirmed = await ctx.ui.confirm("Confirm enabling scheduled command", [`Enable "${job.name}"?`, ...commandSpecLines(ctx.cwd, job)].join("\n"));
              if (!confirmed) throw new Error("The user did not confirm enabling the scheduled command; it stays disabled.");
            }
            let updated: CronJob = { ...job, enabled };
            if (enabled && job.command !== undefined) {
              // Apply only the spec the user confirmed: re-read under the storage lock, so a peer edit made while the
              // dialog was open is refused instead of silently enabled and approved.
              const shellOf = (j: CronJob) => j.shell ?? defaultCommandShell();
              let reason = "The job changed while waiting for confirmation; nothing was enabled.";
              const applied = storage.updateJobWith(params.jobId, (current) => {
                if (current.command !== job.command || shellOf(current) !== shellOf(job) || current.cwd !== job.cwd) return undefined;
                const candidate: CronJob = { ...current, enabled: true };
                if (!scheduler.approveCommand(candidate)) { reason = "The working directory is no longer available; the job stays disabled."; return undefined; }
                updated = candidate;
                return { enabled: true };
              });
              if (!applied) throw new Error(reason);
            } else {
              storage.updateJob(params.jobId, { enabled });
            }
            scheduler.updateJob(params.jobId, updated);

            details.jobs = [updated];
            details.jobId = params.jobId;
            details.jobName = job.name;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ ${enabled ? "Enabled" : "Disabled"} cron job "${job.name}" (${params.jobId})`,
                },
              ],
              details,
            };
          }

          case "cleanup": {
            // Only touch jobs this session can see — foreign-session jobs are
            // owned by other pis. Unbound disabled jobs are fair game.
            const mySessionId = ctx.sessionManager.getSessionId();
            const disabledJobs = storage.removeDisabledJobs(mySessionId);

            if (disabledJobs.length === 0) {
              details.jobs = [];
              return {
                content: [
                  {
                    type: "text",
                    text: "No disabled jobs to clean up",
                  },
                ],
                details,
              };
            }

            for (const job of disabledJobs) scheduler.removeJob(job.id);

            details.jobs = disabledJobs;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ Removed ${disabledJobs.length} disabled job(s):\n${disabledJobs.map((j) => `  - ${j.name} (${j.id})`).join("\n")}`,
                },
              ],
              details,
            };
          }

          case "update": {
            if (!params.jobId) {
              throw new Error("jobId is required for update action");
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            // Reject empty-string model (schema also enforces minLength: 1).
            // To switch a job from subagent → inline mode, remove and re-add
            // it without `model` — there's no in-place clearing.
            if (params.model !== undefined && params.model.length === 0) {
              throw new Error(
                "'model' must be a non-empty string. To switch a job from subagent back to inline, remove and re-add it without a model."
              );
            }

            // A job's kind is fixed: command jobs never gain a prompt/model and prompt jobs never gain a command.
            if (job.command !== undefined) {
              const stray = (["prompt", "model", "notify", "extensions", "skills"] as const).filter((key) => params[key] !== undefined);
              if (stray.length > 0) throw new Error(`${stray.map((k) => `'${k}'`).join(", ")} cannot be set on a command job; remove and re-add it to change its kind.`);
              if (params.timeoutMs !== undefined && !isValidCommandTimeout(params.timeoutMs)) throw new Error("'timeoutMs' must be an integer from 1 to 2147483647");
            } else {
              const stray = (["command", "shell", "cwd", "timeoutMs"] as const).filter((key) => params[key] !== undefined);
              if (stray.length > 0) throw new Error(`${stray.map((k) => `'${k}'`).join(", ")} cannot be set on a prompt job; remove and re-add it to change its kind.`);
            }

            const updates: Partial<CronJob> = {};
            if (params.name) updates.name = params.name;
            if (params.prompt) updates.prompt = params.prompt;
            if (params.command !== undefined) updates.command = params.command;
            if (params.shell !== undefined) updates.shell = params.shell as CommandShell;
            if (params.timeoutMs !== undefined) updates.timeoutMs = params.timeoutMs;
            if (params.cwd !== undefined) {
              const resolved = resolveCommandCwd(ctx.cwd, params.cwd);
              if (!resolved.ok) throw new Error(resolved.error);
              updates.cwd = resolved.cwd;
            }
            if (params.description !== undefined) updates.description = params.description;
            if (params.model !== undefined) updates.model = params.model;
            if (params.notify !== undefined) updates.notify = params.notify;
            if (params.extensions !== undefined) updates.extensions = params.extensions;
            if (params.skills !== undefined) updates.skills = params.skills;

            if (params.schedule) {
              // Same resolution rules as `add`: relative time (`+5m`) → ISO,
              // ISO accepted as-is, cron validated by croner.
              const validated = CronScheduler.validateSchedule(job.type, params.schedule);
              if (!validated.ok) throw new Error(validated.error);
              updates.schedule = validated.schedule;
              if (validated.intervalMs !== undefined) updates.intervalMs = validated.intervalMs;
            }

            if (params.endAt !== undefined) {
              updates.endAt = params.endAt === null ? undefined : normalizeEndAt(params.endAt);
            }
            const updated = { ...job, ...updates };
            validateJobDeadline(updated, params.endAt !== undefined && params.endAt !== null);
            if (job.command !== undefined) {
              if (typeof updated.command !== "string" || updated.command.trim().length === 0) throw new Error("'command' must be a non-empty string");
              const same = updated.command === job.command && (updated.shell ?? defaultCommandShell()) === (job.shell ?? defaultCommandShell()) && updated.cwd === job.cwd;
              if (!same) {
                if (!(ctx.hasUI === true && typeof ctx.ui?.confirm === "function")) {
                  throw new Error("Changing a shell command job needs an interactive session so the user can confirm the exact command; nothing was changed.");
                }
                const confirmed = await ctx.ui.confirm("Confirm scheduled command", [`Update "${updated.name}"?`, ...commandSpecLines(ctx.cwd, updated)].join("\n"));
                if (!confirmed) throw new Error("The user did not confirm the changed command; nothing was changed.");
                if (!scheduler.approveCommand(updated)) throw new Error("The working directory is no longer available; nothing was changed.");
              }
            }
            storage.updateJob(params.jobId, updates);
            scheduler.updateJob(params.jobId, updated);

            details.jobs = [updated];
            details.jobId = params.jobId;
            details.jobName = updated.name;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ Updated cron job "${updated.name}" (${params.jobId})\n${deadlineLabel(updated.endAt)}`,
                },
              ],
              details,
            };
          }

          case "list": {
            const mySessionId = ctx.sessionManager.getSessionId();
            const jobs = storage
              .getAllJobs()
              .filter((j) => CronScheduler.isLoadedFor(j, mySessionId));
            details.jobs = jobs;

            if (jobs.length === 0) {
              return {
                content: [{ type: "text", text: "No cron jobs configured." }],
                details,
              };
            }

            const lines = ["Configured cron jobs:", ""];
            for (const job of jobs) {
              const status = job.enabled ? "✓" : "✗";
              const nextRun = scheduler.getNextRun(job.id, job);
              const nextStr = nextRun ? `Next: ${nextRun.toISOString()}` : "";
              const lastStr = job.lastRun ? `Last: ${job.lastRun}` : "Never run";

              lines.push(`${status} ${job.name} (${job.id})`);
              lines.push(`  Type: ${job.type} | Schedule: ${job.schedule}`);
              lines.push(`  ${deadlineLabel(job.endAt)}`);
              if (job.model) {
                lines.push(`  Model: ${job.model} (runs in subagent${job.notify ? ", notifies parent" : ""}${job.extensions ? ", extensions" : ""}${job.skills ? ", skills" : ""})`);
              }
              if (job.command !== undefined) {
                lines.push(`  ${commandLabel(job)}`);
                lines.push(`  Directory: ${job.cwd ?? "(project directory)"}`);
              } else {
                lines.push(`  Prompt: ${job.prompt}`);
              }
              lines.push(`  ${lastStr} ${nextStr ? `| ${nextStr}` : ""}`);
              lines.push(`  Runs: ${job.runCount} | Status: ${job.lastStatus || "pending"}`);
              if (job.description) {
                lines.push(`  Description: ${job.description}`);
              }
              lines.push("");
            }

            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details,
            };
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        details.error = error instanceof Error ? error.message : String(error);
        return {
          // Machine-visible failure: the host/model must not see a rejected request as a successful tool call.
          isError: true,
          content: [
            {
              type: "text",
              text: `✗ Error: ${details.error}`,
            },
          ],
          details,
        };
      }
    },

    renderCall(params, theme) {
      const action = params.action;
      const name = params.name || params.jobId || "";
      const actionText = theme.fg("accent", action);
      const nameText = theme.fg("text", name);

      let text: string;
      switch (action) {
        case "add":
          text = `Adding cron job: ${nameText}`;
          break;
        case "remove":
          text = `Removing cron job: ${nameText}`;
          break;
        case "enable":
        case "disable":
          text = `${actionText.charAt(0).toUpperCase() + actionText.slice(1)} job: ${nameText}`;
          break;
        case "update":
          text = `Updating cron job: ${nameText}`;
          break;
        case "list":
          text = `Listing all cron jobs`;
          break;
        default:
          text = `${actionText} cron job`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      if (!result.details) {
        const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        return new Text(text, 0, 0);
      }

      const details = result.details;
      const lines: string[] = [];

      // Show action result
      if (details.error) {
        lines.push(theme.fg("error", `✗ Error: ${details.error}`));
      } else {
        const action = details.action;
        const jobName = details.jobName || details.jobId || "";
        lines.push(theme.fg("success", `✓ ${action} ${jobName}`));
      }

      if (!details.error && (details.action === "add" || details.action === "update")) {
        for (const job of details.jobs) lines.push(theme.fg("dim", deadlineLabel(job.endAt)));
      }

      // Show job table for list action
      if (details.action === "list" && details.jobs.length > 0) {
        lines.push("");
        lines.push(theme.bold("Cron Jobs:"));
        for (const job of details.jobs) {
          const status = job.enabled ? theme.fg("success", "✓") : theme.fg("muted", "✗");
          lines.push(`${status} ${theme.fg("text", job.name)} ${theme.fg("dim", `(${job.id})`)}`);
          lines.push(
            `  ${theme.fg("dim", "Type:")} ${job.type} ${theme.fg("dim", "| Schedule:")} ${job.schedule}`
          );
          lines.push(`  ${theme.fg("dim", deadlineLabel(job.endAt))}`);
          if (job.model) {
            const subagentTag = job.notify ? "(subagent, notifies parent)" : "(subagent)";
            const tags = [];
            if (job.extensions) tags.push("extensions");
            if (job.skills) tags.push("skills");
            const tagStr = tags.length ? ", " + tags.join(" + ") : "";
            lines.push(`  ${theme.fg("dim", "Model:")} ${job.model} ${theme.fg("dim", subagentTag)}${tagStr}`);
          }
          if (job.command !== undefined) lines.push(`  ${theme.fg("dim", commandLabel(job))}`);
          else lines.push(`  ${theme.fg("dim", "Prompt:")} ${job.prompt}`);
          if (job.lastRun) {
            lines.push(`  ${theme.fg("dim", "Last run:")} ${job.lastRun}`);
          }
          lines.push(`  ${theme.fg("dim", "Runs:")} ${job.runCount}`);
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  };
}
