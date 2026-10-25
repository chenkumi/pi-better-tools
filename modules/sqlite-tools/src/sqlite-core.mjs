import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** node:sqlite reads synchronously on the Pi thread: bound how much one query may materialize. */
export const MAX_QUERY_ROWS = 10_000;
export const MAX_QUERY_BYTES = 8 * 1024 * 1024;
/** BLOB values longer than this are returned as a prefix plus their length. */
export const MAX_BLOB_BYTES = 1024;
/**
 * Bounded wait for another connection's lock. node:sqlite blocks the Pi thread while waiting, so keep it short.
 * The `timeout` option exists since Node 22.16, below the engines floor.
 */
export const BUSY_TIMEOUT_MS = 2000;

/** Non-system tables: shared by the status count and the table list. */
const USER_TABLES = "FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";

const TRANSACTION_CONTROL = /^(?:begin|commit|end|rollback|savepoint|release)(?![A-Za-z0-9_])/i;

/** Strip leading whitespace, semicolons and SQL comments so the first keyword can be inspected. */
function leadingKeywordText(sql) {
  let rest = sql;
  for (;;) {
    const trimmed = rest.replace(/^[\s;]+/, "");
    if (trimmed.startsWith("--")) {
      const newline = trimmed.indexOf("\n");
      rest = newline < 0 ? "" : trimmed.slice(newline + 1);
    } else if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/", 2);
      rest = end < 0 ? "" : trimmed.slice(end + 2);
    } else {
      return trimmed;
    }
  }
}

function assertNotTransactionControl(sql) {
  if (TRANSACTION_CONTROL.test(leadingKeywordText(sql))) {
    throw new Error(
      "Transaction-control statements (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE) are not supported: each statement runs on its own and a left-open transaction would hold the database write lock.",
    );
  }
}

const TRIGGER_STATEMENT = /^create\s+(?:temp\s+|temporary\s+)?trigger\b/i;

/**
 * node:sqlite compiles only the first statement and silently drops the rest. Refuse a trailing statement instead of
 * skipping it. A trigger body holds semicolons of its own, so CREATE TRIGGER is left to SQLite.
 */
function assertSingleStatement(sql) {
  if (TRIGGER_STATEMENT.test(leadingKeywordText(sql))) return;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ;
    const next = sql[index + 1];
    if (char === "'" || char === '"' || char === "`") {
      index += 1;
      while (index < sql.length && !(sql[index] === char && sql[index + 1] !== char)) index += sql[index] === char ? 2 : 1;
    } else if (char === "[") {
      const end = sql.indexOf("]", index + 1);
      index = end < 0 ? sql.length : end;
    } else if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end < 0 ? sql.length : end;
    } else if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 1;
    } else if (char === ";") {
      if (leadingKeywordText(sql.slice(index + 1)).length > 0) {
        throw new Error("Only one SQL statement per call is supported; SQLite would silently ignore the rest. Send each statement in its own call.");
      }
      return;
    }
    index += 1;
  }
}

/** An error already phrased for the agent; it must not be wrapped a second time as a driver error. */
class GuidedError extends Error {}

const SQL_EXCERPT_CHARS = 200;
const BINDING_RULES = "bindings must match the placeholders: an array only for ? placeholders, or an object only for :name/@name/$name placeholders (never mixed)";

function sqlExcerpt(sql) {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > SQL_EXCERPT_CHARS ? `${flat.slice(0, SQL_EXCERPT_CHARS)}...` : flat;
}

function driverHint(message, writes) {
  if (/constraint failed/i.test(message)) return "The statement was not applied. Fix the values (duplicate key, NOT NULL, foreign key) or check the schema with sqlite_describe_table.";
  if (/database is locked|database table is locked|busy/i.test(message)) return "Another process holds a lock on the database; retry later. The statement was not applied.";
  if (/readonly/i.test(message)) return "The database or its directory is read-only; ask the user to fix permissions or configure a writable database.";
  if (/malformed|not a database|encrypted/i.test(message)) return "The file is not a readable SQLite database; check the configured path.";
  if (/named parameter|cannot be bound|bind|column index out of range|too many parameters|parameter/i.test(message)) return `Check that ${BINDING_RULES}.`;
  const next = writes ? "Nothing was changed by this failed statement." : "";
  return `Check the SQL syntax and the table/column names with sqlite_list_tables and sqlite_describe_table. ${next}`.trim();
}

/** Wraps a raw node:sqlite error with the operation, SQLite code, bounded SQL and a fix hint. */
function wrapDriverError(operation, error, sql, writes) {
  if (error instanceof GuidedError) return error;
  const detail = error;
  const code = typeof detail.errcode === "number" ? ` (SQLite code ${detail.errcode}${typeof detail.errstr === "string" ? `: ${detail.errstr}` : ""})` : "";
  const message = errorMessage(error);
  return new Error(`${operation} failed: ${message}${code}. SQL: ${sqlExcerpt(sql)}. ${driverHint(message, writes)}`);
}

const TRUNCATION_HINT = `The result was cut at ${MAX_QUERY_ROWS} rows or ${MAX_QUERY_BYTES} bytes and more rows exist. Narrow it: add WHERE conditions, select fewer or shorter columns, or page with LIMIT n OFFSET m.`;

function boundedValue(value) {
  if (value instanceof Uint8Array && value.length > MAX_BLOB_BYTES) {
    return { type: "Buffer", byteLength: value.length, data: [...value.subarray(0, MAX_BLOB_BYTES)], truncated: true };
  }
  return value;
}

/** Rough serialized size, matching the JSON rendering of bigint and BLOB values. */
function valueBytes(value) {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") + 2;
  if (typeof value === "number" || typeof value === "bigint") return String(value).length;
  if (value instanceof Uint8Array) return value.length * 4 + 32;
  if (typeof value === "object" && "data" in value && Array.isArray(value.data)) return value.data.length * 4 + 64;
  return 16;
}

/** Manages one synchronous SQLite connection for the current pi session. */
export class SqliteManager {
  database;
  currentPath;

  open(filePath) {
    try {
      this.closeIfOpen();
      // Keep the file's own journal mode: switching to WAL would persist in the database header.
      const existed = existsSync(filePath);
      this.database = new DatabaseSync(filePath, { timeout: BUSY_TIMEOUT_MS });
      this.currentPath = filePath;
      return {
        success: true,
        message: existed
          ? `Database opened: ${filePath}`
          : `Database created: ${filePath} did not exist, so a new empty database was created. If you meant an existing database, check the path, then sqlite_open it.`,
      };
    } catch (error) {
      this.forgetConnection();
      return {
        success: false,
        message: `Failed to open database ${filePath}: ${errorMessage(error)}. Check file_path: it must be an existing SQLite file or a new file in an existing, writable directory (absolute or relative to the project cwd; a leading @ is stripped).`,
      };
    }
  }

  close() {
    if (!this.database) {
      return { success: false, message: "No database is currently open." };
    }

    try {
      const closedPath = this.currentPath;
      this.database.close();
      this.forgetConnection();
      return { success: true, message: `Database closed: ${closedPath}` };
    } catch (error) {
      return { success: false, message: `Failed to close database: ${errorMessage(error)}` };
    }
  }

  status() {
    const db = this.database;
    if (!db) return { isOpen: false, filePath: null, tables: null };

    let tables = null;
    try {
      tables = (db.prepare(`SELECT COUNT(*) AS count ${USER_TABLES}`).get()).count;
    } catch {
      // A status call should still succeed if SQLite cannot read its catalogue.
    }

    return { isOpen: true, filePath: this.currentPath ?? null, tables };
  }

  query(sql, params) {
    assertNotTransactionControl(sql);
    assertSingleStatement(sql);
    return this.guardTransaction(() => this.runQuery(sql, params));
  }

  runQuery(sql, params) {
    const statement = this.prepareStatement("sqlite_query", sql, false);
    if (!isReader(statement)) {
      throw new GuidedError("sqlite_query accepts only statements that return rows. Use sqlite_execute for writes.");
    }

    // Column names come from statement metadata, so duplicate names and empty results keep their shape.
    const columns = statement.columns().map((column) => column.name);
    statement.setReturnArrays(true);
    const rows = [];
    let bytes = 0;
    let truncated = false;
    // Stream rows and stop at the bounds; breaking out of the iterator resets the statement.
    try {
      for (const row of statement.iterate(...(this.bindArgs(params)))) {
        const values = row.map(boundedValue);
        const rowBytes = values.reduce((total, value) => total + valueBytes(value) + 8, 8);
        if (rows.length >= MAX_QUERY_ROWS) {
          truncated = true;
          break;
        }
        if (bytes + rowBytes > MAX_QUERY_BYTES) {
          if (rows.length === 0) {
            throw new GuidedError(
              `The first row is larger than the ${MAX_QUERY_BYTES}-byte result budget. Select fewer or shorter columns, for example substr(column, 1, N).`,
            );
          }
          truncated = true;
          break;
        }
        bytes += rowBytes;
        rows.push(values);
      }
    } catch (error) {
      throw wrapDriverError("sqlite_query", error, sql, false);
    }
    return { columns, rows, rowCount: rows.length, ...(truncated ? { truncated: true, hint: TRUNCATION_HINT } : {}) };
  }

  execute(sql, params) {
    assertNotTransactionControl(sql);
    assertSingleStatement(sql);
    return this.guardTransaction(() => this.runExecute(sql, params));
  }

  /** Defense in depth: no tool call may leave the connection inside a transaction (and holding a lock). */
  guardTransaction(run) {
    const db = this.getDatabase();
    const result = run();
    if (db.isTransaction) {
      let detail = "";
      try { db.exec("ROLLBACK"); } catch (error) { detail = ` ROLLBACK failed: ${errorMessage(error)}`; }
      throw new Error(`The statement left a transaction open; it was rolled back so the database lock is released.${detail}`);
    }
    return result;
  }

  runExecute(sql, params) {
    const statement = this.prepareStatement("sqlite_execute", sql, true);
    if (isReader(statement)) {
      throw new GuidedError("sqlite_execute does not accept statements that return rows, including INSERT/UPDATE/DELETE ... RETURNING. Use sqlite_query instead.");
    }

    let result;
    try {
      result = statement.run(...(this.bindArgs(params)));
    } catch (error) {
      throw wrapDriverError("sqlite_execute", error, sql, true);
    }
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  prepareStatement(operation, sql, writes) {
    const db = this.getDatabase();
    try {
      return db.prepare(sql);
    } catch (error) {
      throw wrapDriverError(operation, error, sql, writes);
    }
  }

  listTables() {
    const rows = this.getDatabase().prepare(`SELECT name ${USER_TABLES} ORDER BY name`).all();
    return { tables: rows.map((row) => row.name) };
  }

  describeTable(tableName) {
    const db = this.getDatabase();
    const quotedName = quoteSqlString(tableName);
    const columns = db.prepare(`PRAGMA table_info(${quotedName})`).all();

    if (columns.length === 0) throw new Error(`Table '${tableName}' not found. Use sqlite_list_tables for valid names; the name is case-sensitive and must not include a schema prefix.`);

    const rowCount = (db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get()).count;

    return {
      name: tableName,
      columns: columns.map((column) => ({
        cid: column.cid,
        name: column.name,
        type: column.type,
        notnull: column.notnull === 1,
        defaultValue: column.dflt_value,
        pk: column.pk > 0,
      })),
      rowCount,
    };
  }

  getDatabase() {
    if (!this.database) {
      throw new Error("No database is currently open. Use sqlite_open to open a database first.");
    }
    return this.database;
  }

  bindArgs(params) {
    if (params === undefined) return [];
    return Array.isArray(params) ? [...params] : [params];
  }

  closeIfOpen() {
    if (!this.database) return;
    this.database.close();
    this.forgetConnection();
  }

  forgetConnection() {
    this.database = undefined;
    this.currentPath = undefined;
  }
}

function isReader(statement) {
  return statement.columns().length > 0;
}

function quoteSqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
