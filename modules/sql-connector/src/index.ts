import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configuredEngines, loadSqlConnectorConfig } from "./config.js";
import { buildSqlConnectorPrompt } from "./prompt.js";
import { SqlConnectorRuntime } from "./runtime.js";
import { registerEngineTools } from "./tools.js";
import { SqlConnectorError } from "./types.js";

export default function sqlConnectorExtension(pi: ExtensionAPI): void {
  let runtime: SqlConnectorRuntime | undefined;
  const registeredEngines = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    runtime = undefined;

    if (!ctx.isProjectTrusted()) {
      ctx.ui.setStatus("sql-connector", undefined);
      return;
    }

    try {
      const config = await loadSqlConnectorConfig(ctx.cwd);
      if (!config) {
        ctx.ui.setStatus("sql-connector", undefined);
        return;
      }

      runtime = new SqlConnectorRuntime(config);
      const engines = configuredEngines(config);
      for (const engine of engines) {
        if (!registeredEngines.has(engine)) {
          registerEngineTools(pi, runtime, engine, buildSqlConnectorPrompt({ [engine]: config[engine] }));
          registeredEngines.add(engine);
        }
      }
      ctx.ui.setStatus("sql-connector", engines.length > 0 ? `SQL: ${engines.join(", ")}` : "SQL: no databases configured");
    } catch (error) {
      const message = error instanceof SqlConnectorError ? `${error.code}: ${error.message}` : "Unable to load SQL connector configuration.";
      ctx.ui.setStatus("sql-connector", "SQL: configuration error");
      if (ctx.hasUI) ctx.ui.notify(message, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runtime?.close();
    runtime = undefined;
    ctx.ui.setStatus("sql-connector", undefined);
  });

  pi.registerCommand("sql-connector-reload", {
    description: "Reload SQL Connector configuration and close existing database pools",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });
}
