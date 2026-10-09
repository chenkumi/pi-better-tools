/**
 * /pi-vcc command — triggers pi-vcc compaction.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/commands/pi-vcc.ts)
 * Modified by pi-vcc-om:
 * - Flushes pending OM state (observations/reflections/dropped) when manual mode is active
 *   before triggering compaction, so the compaction summary includes all accumulated memory.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../om/runtime.js";
import {
  PI_VCC_COMPACT_INSTRUCTION,
  notifyMigrationReminder,
  formatCompactionStats,
} from "../hooks/before-compact";


/**
 * One message per host refusal, shared by the pre-check and the onError
 * backstop. "info", not "error": nothing failed — the session simply has
 * nothing above the host's keep-recent budget, which is the same state the
 * auto-compaction trigger treats silently.
 */
const manualRefusalMessage = (reason: "already_compacted" | "too_small"): string =>
  reason === "already_compacted"
    ? "blackhole: already compacted — nothing new to compact since the last summary"
    : "blackhole: nothing to compact yet — Pi's keep-recent budget still covers this branch";

export const registerPiVccCommand = (pi: ExtensionAPI, runtime: Runtime) => {
  const prefixMatch = (value: string, prefix: string): boolean => {
    return value.toLowerCase().startsWith(prefix.toLowerCase());
  };

  pi.registerCommand("blackhole", {
    description:
      "Manual compact with structural summary. Subcommands: [settings] config overlay, " +
      "[changelog] display changelog, [cleanup] remove orphaned files, [om-off]/[om-on] disable/enable observational memory.",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        {
          value: "settings",
          label: "Open configuration overlay [settings]",
        },
        {
          value: "changelog",
          label: "Display changelog [changelog]",
        },
        {
          value: "cleanup",
          label: "Remove orphaned pending files [cleanup]",
        },
        { value: "om-off", label: "Disable observational memory [om-off]" },
        { value: "om-on", label: "Enable observational memory [om-on]" },
      ];
      if (!prefix) return subcommands;
      // "configure" is an accepted alias for "settings" (routed by the
      // handler); surface the settings entry when the user types either.
      return subcommands.filter(
        (s) =>
          prefixMatch(s.value, prefix) ||
          (s.value === "settings" && prefixMatch("configure", prefix)),
      );
    },
    handler: async (args, ctx) => {
      // The manual path reads runtime.config below (and the flush depends on it),
      // but a command can be the first thing that runs in a session — load the
      // config before the first read so a configured `compaction: "manual"`
      // session does not fall back to DEFAULTS.
      runtime.ensureConfig(ctx.cwd ?? process.cwd(), (msg) => ctx.ui.notify(msg, "warning"));
      const sessionId = ctx.sessionManager.getSessionId();

      // Handle subcommands
      const trimmed = (typeof args === "string" ? args : "").trim();
      if (trimmed === "configure" || trimmed === "settings") {
        // Open the config overlay ("configure" kept as a hidden alias)
        const { openBlackholeSettings, config, GLOBAL_CONFIG_DIR } =
          await import("../pi-base/blackhole-settings.js");
        await openBlackholeSettings(ctx);
        const resolved = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR);
        config.notifyWarnings(resolved, message => ctx.ui.notify(message, "warning"));
        runtime.config = resolved.config;
        runtime.configLoaded = true;
        return;
      }
      if (trimmed === "changelog") {
        const { openChangelogView } = await import("../changelog/changelog.js");
        await openChangelogView(ctx);
        return;
      }
      if (trimmed === "cleanup") {
        const { handleCleanup } = await import("./cleanup.js");
        await handleCleanup(ctx);
        return;
      }
      if (trimmed === "om-off") {
        const { config, GLOBAL_CONFIG_DIR } = await import("../pi-base/blackhole-settings.js");
        try {
          config.save(
            { ...config.load(ctx.cwd, GLOBAL_CONFIG_DIR), memory: false },
            "global",
            ctx.cwd,
            GLOBAL_CONFIG_DIR,
          );
          const resolved = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR);
        config.notifyWarnings(resolved, message => ctx.ui.notify(message, "warning"));
        runtime.config = resolved.config;
          ctx.ui.notify(
            "Observational memory disabled. Use /blackhole om-on to re-enable.",
            "info",
          );
        } catch {
          ctx.ui.notify(
            "Failed to save config — the config file may be read-only (e.g., managed by Nix). " +
              "Runtime state updated for this session only.",
            "warning",
          );
        }
        return;
      }
      if (trimmed === "om-on") {
        const { config, GLOBAL_CONFIG_DIR } = await import("../pi-base/blackhole-settings.js");
        try {
          config.save(
            { ...config.load(ctx.cwd, GLOBAL_CONFIG_DIR), memory: true },
            "global",
            ctx.cwd,
            GLOBAL_CONFIG_DIR,
          );
          const resolved = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR);
        config.notifyWarnings(resolved, message => ctx.ui.notify(message, "warning"));
        runtime.config = resolved.config;
          ctx.ui.notify("Observational memory enabled.", "info");
        } catch {
          ctx.ui.notify(
            "Failed to save config — the config file may be read-only (e.g., managed by Nix). " +
              "Runtime state updated for this session only.",
            "warning",
          );
        }
        return;
      } // Warn if input starts with a known subcommand but isn't an exact match.
      // Prevents "/blackhole configure foo" from silently becoming a follow-up.
      const SUBCOMMAND_NAMES = ["configure", "settings", "changelog", "cleanup", "om-off", "om-on"];
      const nearMiss = SUBCOMMAND_NAMES.find(
        (name) =>
          trimmed.toLowerCase().startsWith(name.toLowerCase()) && trimmed.length > name.length,
      );
      if (nearMiss) {
        ctx.ui.notify(
          `/blackhole ${nearMiss} accepts no arguments. Did you mean "/blackhole ${nearMiss}"?`,
          "warning",
        );
        return;
      }

      // Extract follow-up prompt: everything after the subcommand check
      // that isn't a known subcommand is treated as follow-up text.
      const followUpPrompt = trimmed ? trimmed : null;

      // Native public request alias. Pi decides eligibility, cuts, cancellation and retry.
      // Pending OM is flushed by the summary hook only after Pi emits an admitted preparation.
      ctx.compact({
        customInstructions: PI_VCC_COMPACT_INSTRUCTION,
        onComplete: () => {
          const stats = runtime.compactionStats;
          if (stats) {
            ctx.ui.notify(formatCompactionStats(stats), "info");
          } else {
            ctx.ui.notify("Compacted with blackhole", "info");
          }
          notifyMigrationReminder(sessionId, (msg, level) => ctx.ui.notify(msg, level as any));

          // Fire follow-up prompt after compaction completes
          if (followUpPrompt) {
            try {
              void Promise.resolve(pi.sendUserMessage(followUpPrompt)).catch(() => {});
            } catch {}
          }
        },
        onError: (err) => {
          const message = String(err?.message ?? err);
          // Native refusal is information, not a Blackhole scheduling failure.
          if (message.startsWith("Nothing to compact")) {
            ctx.ui.notify(manualRefusalMessage("too_small"), "info");
          } else if (message === "Already compacted") {
            ctx.ui.notify(manualRefusalMessage("already_compacted"), "info");
          } else if (message === "Compaction cancelled") {
            // Pi owns cancellation and renders its manual abort; do not add a retry or second toast.
          } else {
            ctx.ui.notify(`Compaction failed: ${message}`, "error");
          }
        },
      });
    },
  });
};
