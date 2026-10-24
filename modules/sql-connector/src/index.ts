import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configuredEngines, loadSqlConnectorConfig } from "./config.js";
import { buildSqlConnectorPrompt } from "./prompt.js";
import { SqlConnectorRuntime } from "./runtime.js";
import { registerEngineTools } from "./tools.js";
import { SqlConnectorError } from "./types.js";

const NOTICE_SECTION = "pi_sql_connector_config_error";

/**
 * The agent-facing reason is already neutral (no settings fields, files or variables; see config.ts); the notice is
 * single-line and bounded.
 */
function configErrorNotice(message: string): string {
  const bounded = message.replace(/\s+/g, " ").trim().slice(0, 600);
  return `SQL connector: the project's database connection settings could not be loaded, so the MySQL, Microsoft SQL Server and PostgreSQL tools (mysql_*, mssql_*, pgsql_*) are not available in this session. Reason: ${bounded} Ask the user to fix the connection settings, then run /sql-connector-reload (or /reload). Do not change the connection settings yourself to work around this.`;
}

export default function sqlConnectorExtension(pi: ExtensionAPI): void {
  let runtime: SqlConnectorRuntime | undefined;
  let configError: string | undefined;
  const registeredEngines = new Set<string>();

  // Without tools the agent cannot learn why they are missing, so a failed load is explained in the system prompt.
  pi.on("before_agent_start", (event) => {
    if (!configError) return;
    const notice = configErrorNotice(configError);
    const options = event.systemPromptOptions as { sections?: Record<string, string>; forceSystemPrompt?: string } | undefined;
    if (options?.sections) {
      options.sections[NOTICE_SECTION] = notice;
      if (options.forceSystemPrompt === undefined) return;
    }
    const base = event.systemPrompt;
    return base.includes(notice) ? undefined : { systemPrompt: `${base}\n\n${notice}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    runtime = undefined;
    configError = undefined;

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
      // The agent sees the neutral wording; the human UI notice keeps the exact field, file and variable names.
      const agentMessage = error instanceof SqlConnectorError ? `${error.code}: ${error.message}` : "Unable to load the database connection settings (unexpected error; ask the user to check them).";
      const humanMessage = error instanceof SqlConnectorError ? `${error.code}: ${error.humanMessage ?? error.message}` : "Unable to load SQL connector configuration (unexpected error; ask the user to check .pi/agent/sql-connector.json).";
      configError = agentMessage;
      ctx.ui.setStatus("sql-connector", "SQL: configuration error");
      if (ctx.hasUI) ctx.ui.notify(humanMessage, "error");
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
