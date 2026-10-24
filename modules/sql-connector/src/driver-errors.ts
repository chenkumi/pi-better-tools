import type { DatabaseConfig, Engine } from "./types.js";
import { SqlConnectorError } from "./types.js";

/** Longest driver message surfaced to the agent after redaction. */
const MAX_DRIVER_MESSAGE_CHARS = 300;

export interface DriverErrorContext {
  /** True for `<engine>_update`: the outcome of the statement must be stated. */
  write?: boolean;
  config?: DatabaseConfig;
  queryTimeoutMs?: number;
  connectTimeoutMs?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes anything that can carry a credential or the connection identity from driver text: the configured password
 * and user name, connection-string style secrets and URL user info. Then caps the length.
 */
export function redactDriverText(text: string, config?: DatabaseConfig): string {
  let result = text;
  if (config?.password) result = result.split(config.password).join("[REDACTED]");
  for (const identity of [config?.username, config?.host]) {
    if (identity && identity.length >= 3) {
      result = result.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(identity)}(?![A-Za-z0-9_])`, "gi"), "[REDACTED]");
    }
  }
  result = result
    .replace(/\b(password|pwd|passwd|secret|token|user\s*id|uid)\s*[=:]\s*("[^"]*"|'[^']*'|[^;\s,]+)/gi, "$1=[REDACTED]")
    .replace(/:\/\/[^\s/@]+@/g, "://[REDACTED]@")
    .replace(/\s+/g, " ")
    .trim();
  return result.length > MAX_DRIVER_MESSAGE_CHARS ? `${result.slice(0, MAX_DRIVER_MESSAGE_CHARS)}...` : result;
}

interface Facts {
  code: string;
  sqlState: string;
  errno?: number;
  number?: number;
  line?: number;
  position?: string;
  name: string;
  message: string;
}

function facts(engine: Engine, error: unknown): Facts {
  const source = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const original = (typeof source.originalError === "object" && source.originalError !== null ? source.originalError : {}) as Record<string, unknown>;
  const pick = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined);
  const code = source.code === undefined || source.code === null ? "" : String(source.code);
  const sqlState = typeof source.sqlState === "string"
    ? source.sqlState
    : engine === "pgsql" && /^[0-9A-Z]{5}$/.test(code) ? code : "";
  return {
    code,
    sqlState,
    errno: engine === "mysql" ? pick(source.errno) : undefined,
    number: engine === "mssql" ? pick(source.number) ?? pick((original.info as { number?: unknown } | undefined)?.number) : undefined,
    line: pick(source.lineNumber),
    position: typeof source.position === "string" || typeof source.position === "number" ? String(source.position) : undefined,
    name: typeof source.name === "string" ? source.name : "Error",
    message: typeof source.sqlMessage === "string" ? source.sqlMessage : error instanceof Error ? error.message : String(error),
  };
}

type Kind = "timeout" | "auth" | "connectivity" | "permission" | "constraint" | "syntax" | "queue" | "unknown";

const PERMISSION_MYSQL = new Set([1044, 1142, 1143, 1227, 1370]);
const PERMISSION_MSSQL = new Set([229, 230, 262, 297, 300]);
const CONSTRAINT_MYSQL = new Set([1048, 1062, 1216, 1217, 1264, 1265, 1292, 1366, 1406, 1451, 1452, 3819]);
const CONSTRAINT_MSSQL = new Set([220, 242, 245, 515, 547, 2601, 2627, 8114, 8115, 8152]);
const SYNTAX_MYSQL = new Set([1049, 1051, 1052, 1054, 1058, 1060, 1064, 1066, 1109, 1136, 1146, 1210, 1305]);
const SYNTAX_MSSQL = new Set([102, 105, 137, 156, 170, 195, 201, 207, 208, 8144, 8178]);

function classify(engine: Engine, f: Facts): Kind {
  const state = f.sqlState;
  const n = engine === "mysql" ? f.errno : f.number;
  // PostgreSQL 08P01 is a bind message with the wrong parameter count, not a lost connection.
  if (engine === "pgsql" && state === "08P01") return "syntax";
  if (engine === "pgsql" && state === "42501") return "permission";
  if ((engine === "mysql" && n !== undefined && PERMISSION_MYSQL.has(n)) || (engine === "mssql" && n !== undefined && PERMISSION_MSSQL.has(n)) || /^ER_(TABLE|COLUMN|DB|PROCACCESS)ACCESS_DENIED/i.test(f.code)) {
    return "permission";
  }
  if (engine === "pgsql" && state === "57014") return "timeout";
  if (/(timeout|etimedout|esocket|econnreset|econnclosed|ecancel)/i.test(f.code)) return "timeout";
  if (engine === "pgsql" && /^(28)/.test(state)) return "auth";
  if ((engine === "mysql" && n === 1045) || (engine === "mssql" && (n === 18456 || n === 4060))) return "auth";
  if (/(access_denied|elogin|28p01|authentication|certificate|tls)/i.test(f.code)) return "auth";
  if (/(econnrefused|enotfound|ehostunreach|eai_again)/i.test(f.code) || (engine === "pgsql" && /^08/.test(state))) return "connectivity";
  if (/queue limit/i.test(f.message) && engine === "mysql") return "queue";
  if (engine === "pgsql" && /^(23|22)/.test(state)) return "constraint";
  if (engine === "mysql" && n !== undefined && CONSTRAINT_MYSQL.has(n)) return "constraint";
  if (engine === "mssql" && n !== undefined && CONSTRAINT_MSSQL.has(n)) return "constraint";
  if (engine === "pgsql" && /^42/.test(state)) return "syntax";
  if (engine === "mysql" && ((n !== undefined && SYNTAX_MYSQL.has(n)) || /^ER_(PARSE_ERROR|SYNTAX_ERROR|NO_SUCH_TABLE|BAD_FIELD_ERROR|BAD_DB_ERROR)$/.test(f.code))) return "syntax";
  if (engine === "mssql" && n !== undefined && SYNTAX_MSSQL.has(n)) return "syntax";
  if (!f.code && !state && n === undefined && /(query read timeout|timed out|timeout)/i.test(f.message)) return "timeout";
  return "unknown";
}

function diagnostics(f: Facts): string {
  const parts = [
    f.sqlState && `SQLSTATE ${f.sqlState}`,
    f.code && `code ${f.code}`,
    f.errno !== undefined && `errno ${f.errno}`,
    f.number !== undefined && `error ${f.number}`,
    f.line !== undefined && `line ${f.line}`,
    f.position !== undefined && `position ${f.position}`,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/**
 * Turns a driver failure into an agent-readable error: category, safe driver code, a redacted and capped driver message
 * where it cannot name the server or account, how to fix it, and (for writes) whether the statement was applied.
 */
export function classifyDriverError(engine: Engine, error: unknown, context: DriverErrorContext = {}): SqlConnectorError {
  const f = facts(engine, error);
  const kind = classify(engine, f);
  const diag = diagnostics(f);
  const message = redactDriverText(f.message, context.config);
  const write = context.write === true;
  const unknownOutcome = " The update may or may not have been applied; verify with a SELECT before retrying.";
  const notApplied = " The update was not applied.";

  switch (kind) {
    case "timeout":
      return new SqlConnectorError("TIMEOUT", `${engine} request timed out or the connection was interrupted${diag} (limits: ${context.connectTimeoutMs ?? 10_000} ms to connect, ${context.queryTimeoutMs ?? 30_000} ms per query). Retry once, or narrow the statement (add WHERE, lower LIMIT/TOP, select fewer columns).${write ? unknownOutcome : ""}`);
    case "auth":
      return new SqlConnectorError("AUTH_OR_TLS", `${engine} authentication or TLS configuration failed${diag}. Do not retry: ask the user to check the user account, the user password and the TLS settings of the ${engine} connection.${write ? notApplied : ""}`);
    case "connectivity": {
      const refused = /econnrefused|enotfound|ehostunreach|eai_again/i.test(f.code);
      return new SqlConnectorError("CONNECTIVITY", `${engine} database connection failed${diag}: the configured ${engine} server could not be reached${refused ? "" : " or the connection was lost"}. Ask the user to check the database host and port of the ${engine} connection and that the server is running; retry only after that.${write ? (refused ? notApplied : unknownOutcome) : ""}`);
    }
    case "queue":
      return new SqlConnectorError("CONNECTIVITY", `${engine} connection pool queue is full${diag}: too many concurrent requests. Wait and retry sequentially.${write ? notApplied : ""}`);
    case "permission":
      return new SqlConnectorError("DRIVER_INTERNAL", `${engine} permission denied${diag}: ${message}. The database account lacks the needed privilege; do not retry. Ask the user to grant access or use another account.${write ? notApplied : ""}`);
    case "constraint":
      return new SqlConnectorError("SQL_CONSTRAINT", `${engine} constraint or data-value error${diag}: ${message}. Fix the values (duplicate key, NOT NULL, foreign key, type or length) and retry.${write ? notApplied : ""}`);
    case "syntax":
      return new SqlConnectorError("SQL_SYNTAX", `${engine} rejected the SQL${diag}: ${message}. Fix the statement (syntax, table or column names, parameter count) and retry; inspect the schema with ${engine === "mssql" ? "INFORMATION_SCHEMA.COLUMNS" : engine === "pgsql" ? "information_schema.columns" : "SHOW TABLES / DESCRIBE <table>"} if unsure.${write ? notApplied : ""}`);
    default:
      return new SqlConnectorError("DRIVER_INTERNAL", `${engine} database request failed${diag}: ${f.name}: ${message}. This is not a recognised SQL error; do not retry blindly and tell the user.${write ? unknownOutcome : ""}`);
  }
}

/** For errors that are not database failures (a missing optional driver module, a programming error). */
export function describeUnexpectedError(error: unknown): SqlConnectorError {
  const source = (typeof error === "object" && error !== null ? error : {}) as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof source.name === "string" ? source.name : "Error";
  const code = typeof source.code === "string" ? ` (code ${source.code})` : "";
  const message = redactDriverText(typeof source.message === "string" ? source.message : String(error));
  const missingModule = /cannot find module|module_not_found|msnodesqlv8|odbc/i.test(`${source.code ?? ""} ${message}`);
  return new SqlConnectorError(
    "DRIVER_INTERNAL",
    `SQL connector internal error: ${name}${code}: ${message}.${missingModule ? " A database driver module could not be loaded; for MSSQL Windows authentication the user must install msnodesqlv8 and an ODBC driver (see the module README)." : " Do not retry blindly; tell the user."}`,
  );
}
