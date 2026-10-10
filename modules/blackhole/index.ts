/**
 * Unified entry point. Registers all pi-vcc + observational-memory
 * commands, hooks, and tools.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/index.ts)
 *           https://github.com/sting8k/pi-vcc (index.ts)
 * Merged and extended by pi-vcc-om.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordProjectTrust } from "./src/core/project-trust.js";
import { scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerCompactFailedHook } from "./src/hooks/compact-failed.js";
import { registerCompactionContextHook } from "./src/hooks/compaction-context.js";
import { registerPreCompactionOutput } from "./src/hooks/cosmetic-output.js";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerMemoryCommand } from "./src/commands/memory";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerBlackholeExportCommand } from "./src/commands/blackhole-export";
import { registerConsolidationTrigger } from "./src/om/consolidation.js";

import { registerStatusBar } from "./src/om/status-bar.js";
import { registerRecallTool } from "./src/tools/recall";
import { Runtime } from "./src/om/runtime.js";
import { captureRegisteredProviderStreams } from "./src/om/provider-stream.js";
import { config as settingsConfig } from "./src/pi-base/blackhole-settings.js";


export default async (pi: ExtensionAPI) => {
  // Pi alone owns compaction scheduling/cuts/retry. No private inline adapter is installed.
  // ── Bridge: capture custom provider stream functions for jiti-loaded agents ──
  // pi-blackhole's consolidation agents are loaded via jiti with moduleCache: false,
  // which creates a separate pi-ai instance whose apiProviderRegistry lacks custom
  // providers (e.g., claude-bridge registered by other extensions). This bridge stores
  // streamSimple functions in a Symbol.for() global so agents can access them without
  // going through pi-ai's registry.
  //
  // Capture custom provider streams from Pi's model registry before each run.
  // This works regardless of extension load order and includes providers added
  // after startup.
  const PROVIDER_STREAMS_KEY = Symbol.for("pi-blackhole:provider-streams");
  const providerStreams: Map<string, Function> = ((globalThis as any)[PROVIDER_STREAMS_KEY] ??=
    new Map());
  pi.on("agent_start", (_event: unknown, ctx: any) => {
    captureRegisteredProviderStreams(ctx.modelRegistry, providerStreams);
  });

  scaffoldSettings();

  const omRuntime = new Runtime();
  const resolveSessionSettings = (_event: unknown, ctx: any) => {
    const warnings: string[] = [];
    // One fresh-ctx trust decision feeds runtime config, ConfigManager layers and the settings UI (D01).
    recordProjectTrust(ctx.cwd, ctx);
    omRuntime.reloadConfig(ctx.cwd, message => warnings.push(message));
    // Unified file/PASSIVE/explicit-env resolution runs once. Session overrides
    // are then validated purely, using public host identity and fresh ancestry.
    const base = omRuntime.config, append = (type: string, data: unknown) => pi.appendEntry(type, data);
    omRuntime.config = settingsConfig.resolveHostSession(base, ctx, append);
    if (ctx.hasUI === true && typeof ctx.ui?.notify === "function") {
      let attempted = false;
      settingsConfig.notifyWarnings({ config: omRuntime.config, warnings: warnings.map(message => ({ scope: "global" as const, message })) }, message => {
        attempted = true;
        ctx.ui.notify(message, "warning");
      });
      // An outer warning callback may navigate, including before throwing.
      // Reproject from the lower-layer base, never a previously applied override.
      if (attempted) omRuntime.config = settingsConfig.resolveHostSession(base, ctx, append);
    }
  };
  pi.on("session_start", resolveSessionSettings);
  pi.on("session_tree", resolveSessionSettings);


  // Observational memory: background consolidation pipeline
  registerConsolidationTrigger(pi, omRuntime); // agent_start + turn_end → observer/reflector/dropper
  // Deliberately no BH turn_end/agent_end threshold scheduling or idle polling.
  registerStatusBar(pi, omRuntime); // footer gauges (O/P/X) + worker events (config.statusBar)

  // Pi-vcc: compaction + om injection
  registerBeforeCompactHook(pi, omRuntime); // session_before_compact → pi-vcc + om content
  registerCompactFailedHook(pi, omRuntime); // session_compact_failed → failure visibility + compactInFlight guard (pi >= 0.84.3)
  registerCompactionContextHook(pi, omRuntime); // context → immutable append segment projection
  registerPreCompactionOutput(pi, omRuntime); // session_compact → display-only copy of dropped output

  // Commands
  registerPiVccCommand(pi, omRuntime); // /pi-vcc (needs runtime for noAutoCompact flush)
  registerMemoryCommand(pi, omRuntime); // /blackhole-memory [status|view|full]
  registerVccRecallCommand(pi); // /blackhole-recall <query>
  registerBlackholeExportCommand(pi); // /blackhole-export [out:<path>]

  // Tools
  registerRecallTool(pi, omRuntime); // unified recall (#N + [12char]), budget-capped
};
