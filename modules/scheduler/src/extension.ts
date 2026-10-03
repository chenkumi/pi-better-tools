import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerScheduleCommands } from "./commands.js";
import { resolveSchedulerPaths } from "./paths.js";
import { RegistryStore } from "./registry-store.js";
import { RunStore } from "./run-store.js";
import { SessionScheduler } from "./session-scheduler.js";
import { AppScheduler } from "./app-scheduler.js";
import { createProductionRunner } from "./runner.js";
import { SchedulerService } from "./scheduler-service.js";
import { registerScheduleTools } from "./tools.js";

/** Register tools eagerly; resources start only once Pi has a session. No OS services. */
export default function registerPiScheduler(pi: ExtensionAPI): void {
  const paths = resolveSchedulerPaths();
  const registry = new RegistryStore({ registryPath: paths.registryPath, lockPath: paths.lockPath });
  const runs = new RunStore({ runsPath: paths.runsPath, lockPath: paths.lockPath, logsDir: paths.logsDir });
  const session = new SessionScheduler({ registry, runs, pi });
  const app = new AppScheduler(createProductionRunner(paths.agentDir, { internalPoll: false }), session);
  const service = new SchedulerService(registry, runs, app);

  registerScheduleTools(pi, service);
  registerScheduleCommands(pi, service);

  pi.on("session_start", async (_event, ctx) => {
    await app.start(ctx);
    const status = await app.status();
    ctx.ui.setStatus("pi-scheduler", `scheduler: ${status.role} (app-open only)`);
    if (status.lastError || status.sessionError) ctx.ui.notify(`Scheduler: ${status.lastError ?? status.sessionError}`, "error");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    try { await app.stop(); }
    finally { ctx.ui.setStatus("pi-scheduler", undefined); }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await session.settled();
    ctx.ui.setStatus("pi-scheduler", `scheduler: ${(await app.status()).role} (app-open only)`);
  });
  pi.on("input", (event, ctx) => session.handleInput(event, ctx));
  pi.on("before_agent_start", (event, ctx) => session.beforeAgentStart(event, ctx));
  pi.on("message_start", (event, ctx) => session.messageStarted(event, ctx));
  pi.on("message_end", (event) => session.messageEnded(event));
  pi.on("agent_end", (event) => session.agentEnded(event));
  pi.on("model_select", (event) => session.onModelChanged(event.model));
  pi.on("thinking_level_select", (event) => session.onThinkingChanged(event.level));
}
