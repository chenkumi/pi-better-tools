import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SchedulerService } from "./scheduler-service.js";

const help = "Usage: /schedule [status|list|show <id>|runs [id]|cancel <id>|run cancel <run-id>]. Ask the agent to create/update/pause/resume schedules using schedule tools; no JSON input or Windows runner installation is needed.";
function safe(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "); }
function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "error" = "info"): void { ctx.ui.notify(message, level); }

export function registerScheduleCommands(pi: ExtensionAPI, service: SchedulerService): void {
  pi.registerCommand("schedule", {
    description: "Inspect schedules/runs or cancel them. Create and update via agent tools, without JSON.",
    async getArgumentCompletions(prefix) {
      const words = prefix.trim().split(/\s+/);
      if (["show", "cancel", "runs"].includes(words[0]) && words.length <= 2) {
        return (await service.registry.list()).filter((s) => s.id.startsWith(words[1] ?? ""))
          .map((s) => ({ value: `${words[0]} ${s.id}`, label: `${s.id} (${s.state})` }));
      }
      return ["status", "list", "show", "runs", "cancel", "run cancel"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v }));
    },
    async handler(raw, ctx) {
      try {
        const words = raw.trim().split(/\s+/).filter(Boolean);
        const action = words[0] ?? "status";
        if (["status", "list"].includes(action) && words.length <= 1) {
          const status = await service.status({ runsLimit: 0 });
          const lines = status.schedules.map((s) => `${s.id} r${s.revision} ${s.state}${s.consumed ? "/consumed" : ""} ${s.mode} next=${s.nextRun ?? "none"} (${s.timing.timezone})`);
          return notify(ctx, [`Scheduler: ${status.runtime.role}; Pi must stay open; missed runs are not backfilled.`,
            `Now: ${status.localTime}`, status.runtime.lastError, status.runtime.sessionError, status.runtime.independent.lastError,
            ...lines, status.total > lines.length ? `Showing ${lines.length}/${status.total}; use schedule_status pagination.` : undefined,
            !lines.length ? "No schedules." : undefined].filter(Boolean).map((v) => safe(v!)).join("\n"));
        }
        if (action === "show" && words.length === 2) {
          const { schedules } = await service.status({ id: words[1], runsLimit: 0 });
          const s = schedules[0];
          return notify(ctx, safe(`${s.id} r${s.revision} ${s.state} ${s.mode}\n${s.timing.kind}: ${s.timing.expression} (${s.timing.timezone})\nNext: ${s.nextRun ?? "none"}; consumed: ${s.consumed}\nCwd: ${s.cwd}\nPrompt: ${s.prompt}`));
        }
        if (action === "runs" && words.length <= 2) {
          const { runs } = await service.status({ id: words[1], runsLimit: 20 });
          return notify(ctx, runs.length ? runs.map((r) => safe(`${r.runId} ${r.status} ${r.scheduleId} ${r.plannedAt}${r.error ? ` — ${r.error}` : ""}`)).join("\n") : "No runs.");
        }
        if (action === "cancel" && words.length === 2) {
          await service.cancel({ id: words[1] });
          return notify(ctx, `Cancelled future occurrences: ${safe(words[1])}. Active runs are unchanged; use /schedule run cancel <run-id> to stop one.`);
        }
        if (action === "run" && words[1] === "cancel" && words.length === 3) {
          await service.cancel({ runId: words[2] });
          return notify(ctx, `Cancellation requested: ${safe(words[2])}. Inspect /schedule runs for the final outcome.`);
        }
        throw new Error(help);
      } catch (error) { notify(ctx, safe(error instanceof Error ? error.message : String(error)), "error"); }
    },
  });
}
