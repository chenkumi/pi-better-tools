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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SqlConnectorError("CONFIG_INVALID", `Database configuration field \"${field}\" must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  return requiredString(value, field);
}

function resolvePassword(value: unknown, env: NodeJS.ProcessEnv, optional: boolean): string | undefined {
  if (optional && (value === undefined || value === "")) return undefined;
  const password = requiredString(value, "password");
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(password);
  if (!match) return password;

  const resolved = env[match[1]];
  if (!resolved) {
    throw new SqlConnectorError("SECRET_MISSING", "A database password environment variable is not set.");
  }
  return resolved;
}

function parseDatabaseConfig(engine: Engine, value: unknown, env: NodeJS.ProcessEnv): DatabaseConfig {
  if (!isRecord(value)) {
    throw new SqlConnectorError("CONFIG_INVALID", `The \"${engine}\" configuration must be an object.`);
  }

  // A misspelled key (for example `sll`) would otherwise be ignored and silently weaken the connection.
  for (const key of Object.keys(value)) {
    if (!ENGINE_KEYS.includes(key)) {
      throw new SqlConnectorError("CONFIG_INVALID", `Unsupported database configuration field \"${engine}.${key}\".`);
    }
  }

  const windowsAuth = engine === "mssql" && value.windowsAuth === true;
  if (value.windowsAuth !== undefined && (engine !== "mssql" || typeof value.windowsAuth !== "boolean")) {
    throw new SqlConnectorError("CONFIG_INVALID", "Database configuration field \"mssql.windowsAuth\" must be a boolean.");
  }
  const instanceName = engine === "mssql" ? optionalString(value.instanceName, "mssql.instanceName") : undefined;
  if (value.odbcDriver !== undefined && engine !== "mssql") {
    throw new SqlConnectorError("CONFIG_INVALID", "Database configuration field \"mssql.odbcDriver\" is only supported for MSSQL.");
  }
  const odbcDriver = engine === "mssql" && windowsAuth
    ? optionalString(value.odbcDriver, "mssql.odbcDriver") ?? "ODBC Driver 18 for SQL Server"
    : undefined;
  const port = value.port ?? (engine === "mssql" && instanceName ? undefined : DEFAULT_PORT[engine]);
  if (port !== undefined && (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)) {
    throw new SqlConnectorError("CONFIG_INVALID", `Database configuration field \"${engine}.port\" must be an integer from 1 to 65535.`);
  }
  if (value.ssl !== undefined && typeof value.ssl !== "boolean") {
    throw new SqlConnectorError("CONFIG_INVALID", `Database configuration field \"${engine}.ssl\" must be a boolean.`);
  }
  if (value.trustServerCertificate !== undefined && (engine !== "mssql" || typeof value.trustServerCertificate !== "boolean")) {
    throw new SqlConnectorError("CONFIG_INVALID", "Database configuration field \"mssql.trustServerCertificate\" must be a boolean.");
  }

  const optionalCredentials = engine === "mysql" || windowsAuth;
  return {
    host: requiredString(value.host, `${engine}.host`),
    port: port as number | undefined,
    username: optionalCredentials ? optionalString(value.username, `${engine}.username`) : requiredString(value.username, `${engine}.username`),
    password: resolvePassword(value.password, env, optionalCredentials),
    database: engine === "mysql" ? optionalString(value.database, `${engine}.database`) : requiredString(value.database, `${engine}.database`),
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
    throw new SqlConnectorError("CONFIG_INVALID", "Unable to read sql-connector.json.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SqlConnectorError("CONFIG_INVALID", "sql-connector.json is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new SqlConnectorError("CONFIG_INVALID", "sql-connector.json must contain an object.");
  }

  for (const key of Object.keys(parsed)) {
    if (!ENGINES.includes(key as Engine)) {
      throw new SqlConnectorError("CONFIG_INVALID", `Unsupported database key \"${key}\". Use mysql, mssql, or pgsql.`);
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
