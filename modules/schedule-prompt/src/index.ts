/**
 * pi-schedule-prompt — A pi extension for scheduling agent prompts
 *
 * Provides:
 * - A `schedule_prompt` tool for managing scheduled prompts
 * - A widget displaying all scheduled prompts with status
 * - /schedule-prompt command for interactive management
 * - Persistence via .pi/schedule-prompts.json (jobs) and .pi/schedule-prompts-settings.json (settings)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { renderScheduledMessage } from "./ui/message-renderer.js";
import { CronScheduler } from "./scheduler.js";
import { loadSettings, type ScheduleSettings, saveSettings } from "./settings.js";
import { CronStorage } from "./storage.js";
import { createCronTool } from "./tool.js";
import { runAddFlow } from "./ui/add-flow.js";
import { CronWidget } from "./ui/cron-widget.js";
import { JobsView } from "./ui/jobs-view.js";

export default async function (pi: ExtensionAPI) {
  let storage: CronStorage;
  let scheduler: CronScheduler;
  let widget: CronWidget;
  // Refreshed in initializeSession; mutated by Settings submenu. The tool and
  // widget read via closure so toggles take effect without re-registering.
  let settings: ScheduleSettings = {};
  const isWidgetVisible = () => settings.widgetVisible !== false;

  // Register custom message renderer for scheduled prompts
  pi.registerMessageRenderer("scheduled_prompt", renderScheduledMessage);

  // Register the tool once with getter functions
  const tool = createCronTool(
    () => storage,
    () => scheduler,
    () => settings.defaultJobScope ?? "session",
  );
  pi.registerTool(tool);

  // --- Session initialization ---

  const initializeSession = (ctx: any) => {
    // Idempotent: tear down any prior instance before creating a new one.
    // Without this, every `session_start` (fires on reload/resume/fork too, not
    // only on fresh startup) leaks a live croner timer into the event loop,
    // accumulating duplicate fires for every recurring job over time.
    cleanupSession(ctx);

    settings = loadSettings(ctx.cwd);
    storage = new CronStorage(ctx.cwd);
    scheduler = new CronScheduler(storage, pi, ctx);
    widget = new CronWidget(storage, scheduler, pi, isWidgetVisible, ctx.sessionManager.getSessionId());

    try {
      scheduler.start();
      if (isWidgetVisible()) widget.show(ctx);
    } catch (error) {
      // Partial startup also owns timers/listeners and must roll them back.
      cleanupSession(ctx);
      throw error;
    }
  };

  const cleanupSession = (ctx: any) => {
    try {
      scheduler?.stop();
    } finally {
      if (widget) {
        try { widget.hide(ctx); } finally { widget.destroy(); }
      }
    }
  };

  const autoCleanupDisabledJobs = (ctx: any) => {
    // Only sweep our own (or unbound) disabled jobs — never another session's.
    if (!storage) return;
    const mySessionId = ctx.sessionManager.getSessionId();
    const disabledJobs = storage
      .getAllJobs()
      .filter((j) => !j.enabled && CronScheduler.isLoadedFor(j, mySessionId));

    if (disabledJobs.length > 0) {
      console.log(`Auto-cleanup: removing ${disabledJobs.length} disabled job(s)`);
      for (const job of disabledJobs) {
        storage.removeJob(job.id);
      }
    }
  };

  // --- Lifecycle events ---

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") {
      try { autoCleanupDisabledJobs(ctx); }
      catch (error) { console.error("Scheduled prompt optional cleanup failed:", error); }
      finally { cleanupSession(ctx); }
    }
    initializeSession(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Teardown is mandatory even when optional persistence cleanup fails.
    try { autoCleanupDisabledJobs(ctx); } finally { cleanupSession(ctx); }
  });

  // --- Register /schedule-prompt command ---

  pi.registerCommand("schedule-prompt", {
    description: "Manage scheduled prompts interactively",
    handler: async (_args, ctx) => {
      const mySessionId = ctx.sessionManager.getSessionId();

      const action = await ctx.ui.select("Scheduled Prompts", ["Jobs", "Settings"]);
      if (!action) return;

      switch (action) {
        case "Jobs": {
          // Hide the Jobs overlay while the add flow's dialogs are open —
          // otherwise it sits on top of them and steals input.
          let jobsOverlay: OverlayHandle | undefined;
          const wrappedRunAdd = async () => {
            jobsOverlay?.setHidden(true);
            try {
              await runAddFlow(ctx, storage, scheduler, settings, mySessionId);
            } finally {
              jobsOverlay?.setHidden(false);
              jobsOverlay?.focus();
            }
          };
          await ctx.ui.custom<void>(
            (tui, theme, _kb, done) =>
              new JobsView(
                storage,
                scheduler,
                mySessionId,
                wrappedRunAdd,
                theme,
                () => tui.requestRender(),
                () => done(undefined),
              ),
            {
              overlay: true,
              overlayOptions: { width: "100%", maxHeight: "100%" },
              onHandle: (h) => {
                jobsOverlay = h;
              },
            },
          );
          break;
        }

        case "Settings": {
          // Loop so the menu redraws with current state after each change —
          // the menu is the truth display; only persist failures need a toast.
          while (true) {
            const widgetState = isWidgetVisible() ? "shown" : "hidden";
            const bound = (settings.defaultJobScope ?? "session") === "session";
            const choice = await ctx.ui.select("Settings", [
              `Widget visibility: ${widgetState}`,
              `Bind new jobs to session: ${bound ? "yes" : "no"}`,
              "Back",
            ]);
            if (!choice || choice === "Back") return;
            if (choice.startsWith("Widget visibility:")) {
              const next = !isWidgetVisible();
              settings = { ...settings, widgetVisible: next };
              next ? widget.show(ctx) : widget.hide(ctx);
              const persisted = saveSettings(ctx.cwd, { widgetVisible: next });
              if (!persisted) {
                ctx.ui.notify(
                  `Widget ${next ? "shown" : "hidden"} (session only; failed to persist)`,
                  "warning",
                );
              }
            } else if (choice.startsWith("Bind new jobs to session:")) {
              // Affects newly-created jobs only; existing jobs keep their binding.
              const next = bound ? "workdir" : "session";
              settings = { ...settings, defaultJobScope: next };
              const persisted = saveSettings(ctx.cwd, { defaultJobScope: next });
              if (!persisted) {
                ctx.ui.notify(
                  `Bind new jobs to session: ${next === "session" ? "yes" : "no"} (session only; failed to persist)`,
                  "warning",
                );
              }
            }
          }
        }
      }
    },
  });
}
