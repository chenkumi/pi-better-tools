import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ENGINES, type DatabaseConfig, type Engine, type SqlConnectorConfig, SqlConnectorError } from "./types.js";

/** The documented per-engine fields; engine-specific ones are still validated below. */
const ENGINE_KEYS = ["host", "port", "username", "password", "database", "ssl", "windowsAuth", "instanceName", "odbcDriver", "trustServerCertificate"];
const DEFAULT_PORT: Record<Engine, number> = {
  mysql: 3306,
  mssql: 1433,
  pgsql: 5432,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENGINE_LABEL: Record<Engine, string> = { mysql: "MySQL", mssql: "Microsoft SQL Server", pgsql: "PostgreSQL" };
const RELOAD_GUIDANCE = "Ask the user to correct the database connection settings, then run /sql-connector-reload.";

/**
 * Agent-facing text (`message`) never names settings fields, files, paths or environment variables: it describes the
 * affected value in neutral words. The exact names live only in `humanMessage`, which only the human UI shows.
 */
function invalidSettings(agentDetail: string, humanDetail: string): SqlConnectorError {
  return new SqlConnectorError("CONFIG_INVALID", `${agentDetail} ${RELOAD_GUIDANCE}`, humanDetail);
}

/** A settings value described neutrally for the agent (`agent`) and exactly for the human (`human`). */
interface Setting {
  agent: string;
  human: string;
}

function setting(engine: Engine, key: string, agent: string, human = `${engine}.${key}`): Setting {
  return { agent: `the ${ENGINE_LABEL[engine]} ${agent}`, human };
}

function requiredString(value: unknown, field: Setting): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidSettings(`The connection settings are invalid: ${field.agent} must be a non-empty string.`, `Database configuration field \"${field.human}\" must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: Setting): string | undefined {
  if (value === undefined || value === "") return undefined;
  return requiredString(value, field);
}

function resolvePassword(engine: Engine, value: unknown, env: NodeJS.ProcessEnv, optional: boolean): string | undefined {
  if (optional && (value === undefined || value === "")) return undefined;
  const password = requiredString(value, setting(engine, "password", "user password", "password"));
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(password);
  if (!match) return password;

  const resolved = env[match[1]];
  if (!resolved) {
    throw new SqlConnectorError(
      "SECRET_MISSING",
      `The user password for the ${ENGINE_LABEL[engine]} connection is not set in the environment that starts Pi. Ask the user to provide it there (or to enter the password in the connection settings), then run /sql-connector-reload.`,
      `The password environment variable ${match[1]} referenced by sql-connector.json is not set. Ask the user to set ${match[1]} in the environment that starts Pi (or put another variable name in the password field), then run /sql-connector-reload.`,
    );
  }
  return resolved;
}

export function parseDatabaseConfig(engine: Engine, value: unknown, env: NodeJS.ProcessEnv): DatabaseConfig {
  const label = ENGINE_LABEL[engine];
  if (!isRecord(value)) {
    throw invalidSettings(`The connection settings for ${label} must be a JSON object.`, `The \"${engine}\" configuration must be an object.`);
  }

  // A misspelled key (for example `sll`) would otherwise be ignored and silently weaken the connection.
  for (const key of Object.keys(value)) {
    if (!ENGINE_KEYS.includes(key)) {
      throw invalidSettings(`The connection settings for ${label} contain an unsupported entry (a misspelled or unknown option).`, `Unsupported database configuration field \"${engine}.${key}\".`);
    }
  }

  const windowsAuth = engine === "mssql" && value.windowsAuth === true;
  if (value.windowsAuth !== undefined && (engine !== "mssql" || typeof value.windowsAuth !== "boolean")) {
    throw invalidSettings("The connection settings are invalid: the Windows authentication option is only supported for Microsoft SQL Server and must be true or false.", "Database configuration field \"mssql.windowsAuth\" must be a boolean.");
  }
  const instanceName = engine === "mssql" ? optionalString(value.instanceName, setting(engine, "instanceName", "instance name", "mssql.instanceName")) : undefined;
  if (value.odbcDriver !== undefined && engine !== "mssql") {
    throw invalidSettings("The connection settings are invalid: the ODBC driver option is only supported for Microsoft SQL Server.", "Database configuration field \"mssql.odbcDriver\" is only supported for MSSQL.");
  }
  const odbcDriver = engine === "mssql" && windowsAuth
    ? optionalString(value.odbcDriver, setting(engine, "odbcDriver", "ODBC driver name", "mssql.odbcDriver")) ?? "ODBC Driver 18 for SQL Server"
    : undefined;
  const port = value.port ?? (engine === "mssql" && instanceName ? undefined : DEFAULT_PORT[engine]);
  if (port !== undefined && (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)) {
    throw invalidSettings(`The connection settings are invalid: the ${label} database port must be an integer from 1 to 65535.`, `Database configuration field \"${engine}.port\" must be an integer from 1 to 65535.`);
  }
  if (value.ssl !== undefined && typeof value.ssl !== "boolean") {
    throw invalidSettings(`The connection settings are invalid: the ${label} TLS option must be true or false.`, `Database configuration field \"${engine}.ssl\" must be a boolean.`);
  }
  if (value.trustServerCertificate !== undefined && (engine !== "mssql" || typeof value.trustServerCertificate !== "boolean")) {
    throw invalidSettings("The connection settings are invalid: the server certificate trust option is only supported for Microsoft SQL Server and must be true or false.", "Database configuration field \"mssql.trustServerCertificate\" must be a boolean.");
  }

  const optionalCredentials = engine === "mysql" || windowsAuth;
  const usernameSetting = setting(engine, "username", "user account");
  const databaseSetting = setting(engine, "database", "database name");
  return {
    host: requiredString(value.host, setting(engine, "host", "database host")),
    port: port as number | undefined,
    username: optionalCredentials ? optionalString(value.username, usernameSetting) : requiredString(value.username, usernameSetting),
    password: resolvePassword(engine, value.password, env, optionalCredentials),
    database: engine === "mysql" ? optionalString(value.database, databaseSetting) : requiredString(value.database, databaseSetting),
    ssl: value.ssl ?? false,
    windowsAuth,
    instanceName,
    odbcDriver,
    trustServerCertificate: engine === "mssql" && (value.trustServerCertificate ?? false),
  };
}

export async function loadSqlConnectorConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SqlConnectorConfig | undefined> {
  const configPath = join(cwd, CONFIG_DIR_NAME, "agent", "sql-connector.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const errno = (error as NodeJS.ErrnoException).code;
    throw new SqlConnectorError(
      "CONFIG_INVALID",
      `Unable to read the project's database connection settings${errno ? ` (${errno})` : ""}. Ask the user to check that they are stored in a readable file, then run /sql-connector-reload.`,
      `Unable to read ${configPath}${errno ? ` (${errno})` : ""}. Ask the user to check that it is a readable file, then run /sql-connector-reload.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Report only the position: the parser message may quote file content, which can hold credentials.
    const position = /position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(error instanceof Error ? error.message : "");
    const where = position ? ` near position ${position[1]}${position[2] ? ` (line ${position[2]}, column ${position[3]})` : ""}` : "";
    throw new SqlConnectorError(
      "CONFIG_INVALID",
      `The project's database connection settings are not valid JSON${where}. Ask the user to fix the syntax, then run /sql-connector-reload.`,
      `${configPath} is not valid JSON${where}. Ask the user to fix the syntax, then run /sql-connector-reload.`,
    );
  }
  if (!isRecord(parsed)) {
    throw invalidSettings("The project's database connection settings must be a JSON object.", "sql-connector.json must contain an object.");
  }

  for (const key of Object.keys(parsed)) {
    if (!ENGINES.includes(key as Engine)) {
      throw invalidSettings("The project's database connection settings contain an unsupported database type. Only MySQL, Microsoft SQL Server and PostgreSQL are supported.", `Unsupported database key \"${key}\". Use mysql, mssql, or pgsql.`);
    }
  }

  const config: SqlConnectorConfig = {};
  for (const engine of ENGINES) {
    if (parsed[engine] !== undefined) {
      config[engine] = parseDatabaseConfig(engine, parsed[engine], env);
    }
  }
  return config;
}

export function configuredEngines(config: SqlConnectorConfig): Engine[] {
  return ENGINES.filter((engine) => config[engine] !== undefined);
}
