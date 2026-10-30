import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsCommand } from "../../pi-runtime/src/settings-panel/index.js";
import type { Field, Patch, SettingsSchema, Values } from "../../pi-runtime/src/settings-panel/index.js";
import { parseDatabaseConfig } from "./config.js";
import { ENGINES, SqlConnectorError, type Engine } from "./types.js";

type Block = Record<string, unknown>;
type Document = Partial<Record<Engine, Block>>;

const LABEL: Record<Engine, string> = { mysql: "MySQL", mssql: "Microsoft SQL Server", pgsql: "PostgreSQL" };
const DEFAULT_PORT: Record<Engine, number> = { mysql: 3306, mssql: 1433, pgsql: 5432 };
const DEFAULT_ODBC = "ODBC Driver 18 for SQL Server";
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** Validation must not depend on the environment: any `${VAR}` counts as set. */
const anyEnv = new Proxy({}, { get: () => "x" }) as NodeJS.ProcessEnv;

function parse(raw: unknown): Document {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("CONFIG_INVALID: sql-connector.json must contain an object");
  try {
    for (const key of Object.keys(raw)) if (!ENGINES.includes(key as Engine)) throw new Error(`CONFIG_INVALID: unsupported database key "${key}"; use mysql, mssql or pgsql`);
    for (const engine of ENGINES) if ((raw as Document)[engine] !== undefined) parseDatabaseConfig(engine, (raw as Document)[engine], anyEnv);
  } catch (error) {
    // humanMessage names fields, never values; the agent-facing text is not meant for the panel.
    if (error instanceof SqlConnectorError) throw new Error(`CONFIG_INVALID: ${error.humanMessage ?? "a connection value is invalid"}`);
    throw error;
  }
  return raw as Document;
}

function engineFields(engine: Engine): Field[] {
  const group = LABEL[engine], k = (name: string) => `${engine}.${name}`;
  const on = (v: Values) => v[k("enabled")] === true;
  const sql = (v: Values) => on(v) && !(engine === "mssql" && v[k("windowsAuth")] === true);
  return [
    { key: k("enabled"), type: "boolean", group, label: "Enabled", help: `Only configured databases register tools. Turning ${group} off removes its block from the file.` },
    { key: k("host"), type: "string", group, label: "Host", visibleWhen: on },
    { key: k("port"), type: "int", group, label: "Port", min: 1, max: 65535, visibleWhen: (v) => on(v) && !(engine === "mssql" && String(v[k("instanceName")] ?? "").trim() !== ""), help: `Default ${DEFAULT_PORT[engine]}.` },
    { key: k("database"), type: "string", group, label: "Database", visibleWhen: on, help: engine === "mysql" ? "Optional for MySQL." : undefined },
    ...(engine === "mssql" ? [
      { key: k("windowsAuth"), type: "boolean", group, label: "Windows authentication", visibleWhen: on, help: "Needs the optional msnodesqlv8 binding and an ODBC driver; there is no fallback to SQL authentication." } satisfies Field,
      { key: k("instanceName"), type: "string", group, label: "Instance name", visibleWhen: on, help: "Named instance; leave empty to use the port." } satisfies Field,
      { key: k("odbcDriver"), type: "string", group, label: "ODBC driver", visibleWhen: (v: Values) => on(v) && v[k("windowsAuth")] === true, placeholder: DEFAULT_ODBC } satisfies Field,
    ] : []),
    { key: k("username"), type: "string", group, label: "Username", visibleWhen: sql, help: engine === "mysql" ? "Optional for MySQL." : "Use a least-privilege account; reads should use a read-only account." },
    { key: k("passSource"), type: "enum", group, label: "Password source", options: engine === "pgsql" ? ["env", "key"] : ["none", "env", "key"], visibleWhen: sql,
      help: "env: read ${VAR} from the environment that starts Pi (recommended). key: store the password in this file as plain text." },
    { key: k("passEnv"), type: "string", group, label: "Password env name", visibleWhen: (v) => sql(v) && v[k("passSource")] === "env", placeholder: "e.g. PGPASSWORD", help: "The variable name, not the password." },
    { key: k("password"), type: "secret", group, label: "Password", visibleWhen: (v) => sql(v) && v[k("passSource")] === "key", configured: (v) => v[k("passSet")] === true, help: "Plain text in the file. Leave empty to keep the stored password." },
    { key: k("ssl"), type: "boolean", group, label: "TLS", visibleWhen: on },
    ...(engine === "mssql" ? [{ key: k("trustServerCertificate"), type: "boolean", group, label: "Trust server certificate", visibleWhen: on, help: "Skips certificate verification. Only for a local or self-signed server you trust." } satisfies Field] : []),
  ];
}

const FIELDS: readonly Field[] = ENGINES.flatMap(engineFields);

function str(value: unknown): string { return typeof value === "string" ? value : ""; }

export function sqlConnectorSettings(path: string): SettingsSchema<Document> {
  return {
    id: "sql-connector", title: "SQL Connector", path, fields: FIELDS, parse, deleteWhenEmpty: true,
    notice: "This file can hold credentials: keep it out of version control.",
    afterSave: "Takes effect after /reload or /sql-connector-reload.",
    toValues(doc) {
      const v: Values = {};
      for (const engine of ENGINES) {
        const block = doc[engine], k = (name: string) => `${engine}.${name}`;
        const password = str(block?.password), ref = ENV_REFERENCE.exec(password);
        v[k("enabled")] = block !== undefined;
        v[k("host")] = str(block?.host);
        v[k("port")] = typeof block?.port === "number" ? block.port : DEFAULT_PORT[engine];
        v[k("database")] = str(block?.database);
        v[k("username")] = str(block?.username);
        v[k("passSource")] = ref ? "env" : password ? "key" : engine === "pgsql" ? "env" : "none";
        v[k("passEnv")] = ref?.[1] ?? "";
        v[k("passSet")] = !!password && !ref; // presence only; the password is never loaded into the panel
        v[k("ssl")] = block?.ssl === true;
        if (engine === "mssql") {
          v[k("windowsAuth")] = block?.windowsAuth === true;
          v[k("instanceName")] = str(block?.instanceName);
          v[k("odbcDriver")] = str(block?.odbcDriver);
          v[k("trustServerCertificate")] = block?.trustServerCertificate === true;
        }
      }
      return v;
    },
    toPatch(v, dirty, current) {
      const patches: Patch[] = [];
      for (const engine of ENGINES) {
        const k = (name: string) => `${engine}.${name}`;
        if (![...dirty].some((key) => key.startsWith(`${engine}.`))) continue;
        if (v[k("enabled")] !== true) { patches.push({ path: [engine], value: undefined }); continue; }
        // The block is rebuilt from the panel so a newly enabled database gets every field; the parser rejects unknown keys anyway.
        const old = current[engine], block: Block = {};
        const text = (name: string) => String(v[k(name)] ?? "").trim();
        block.host = text("host");
        const instance = engine === "mssql" ? text("instanceName") : "";
        if (!instance && Number(v[k("port")]) !== DEFAULT_PORT[engine]) block.port = Number(v[k("port")]);
        if (text("database")) block.database = text("database");
        const windows = engine === "mssql" && v[k("windowsAuth")] === true;
        if (engine === "mssql") {
          if (windows) block.windowsAuth = true;
          if (instance) block.instanceName = instance;
          if (windows && text("odbcDriver") && text("odbcDriver") !== DEFAULT_ODBC) block.odbcDriver = text("odbcDriver");
          if (v[k("trustServerCertificate")] === true) block.trustServerCertificate = true;
        }
        if (!windows) {
          if (text("username")) block.username = text("username");
          const source = v[k("passSource")];
          if (source === "env") {
            if (!text("passEnv")) throw new Error(`Enter the environment variable name for the ${LABEL[engine]} password (the name, not the password).`);
            block.password = `\${${text("passEnv")}}`;
          } else if (source === "key") {
            const typed = typeof v[k("password")] === "string" ? (v[k("password")] as string).trim() : "";
            const kept = str(old?.password);
            if (typed) block.password = typed;
            else if (kept && !ENV_REFERENCE.test(kept)) block.password = kept;
            else throw new Error(`Enter the ${LABEL[engine]} password, or choose another password source.`);
          }
        }
        if (v[k("ssl")] === true) block.ssl = true;
        patches.push({ path: [engine], value: block });
      }
      return patches;
    },
  };
}

/** Project-level and only for trusted projects, matching where the extension reads the file. */
export function registerSqlConnectorSettings(pi: ExtensionAPI): void {
  registerSettingsCommand(pi, (ctx) => ctx.isProjectTrusted()
    ? sqlConnectorSettings(join(ctx.cwd, CONFIG_DIR_NAME, "agent", "sql-connector.json"))
    : "This project is not trusted, so its database connection settings are not read or written. Trust the project first.",
  { id: "sql-connector", title: "SQL Connector" });
}
