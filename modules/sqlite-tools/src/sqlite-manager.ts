import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type SqlParams = readonly unknown[] | Record<string, unknown>;

/** node:sqlite reads synchronously on the Pi thread: bound how much one query may materialize. */
export const MAX_QUERY_ROWS = 10_000;
export const MAX_QUERY_BYTES = 8 * 1024 * 1024;
/** BLOB values longer than this are returned as a prefix plus their length. */
export const MAX_BLOB_BYTES = 1024;

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  /** Present when the result was cut at MAX_QUERY_ROWS or MAX_QUERY_BYTES; more rows exist. */
  truncated?: true;
}

function boundedValue(value: unknown): unknown {
  if (value instanceof Uint8Array && value.length > MAX_BLOB_BYTES) {
    return { type: "Buffer", byteLength: value.length, data: [...value.subarray(0, MAX_BLOB_BYTES)], truncated: true };
  }
  return value;
}

/** Rough serialized size, matching the JSON rendering of bigint and BLOB values. */
function valueBytes(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") + 2;
  if (typeof value === "number" || typeof value === "bigint") return String(value).length;
  if (value instanceof Uint8Array) return value.length * 4 + 32;
  if (typeof value === "object" && "data" in value && Array.isArray(value.data)) return value.data.length * 4 + 64;
  return 16;
}

export interface SqliteStatus {
  isOpen: boolean;
  filePath: string | null;
  tables: number | null;
}

/** Manages one synchronous SQLite connection for the current pi session. */
export class SqliteManager {
  private database: DatabaseSync | undefined;
  private currentPath: string | undefined;

  open(filePath: string): { success: boolean; message: string } {
    try {
      this.closeIfOpen();
      // Keep the file's own journal mode: switching to WAL would persist in the database header.
      const existed = existsSync(filePath);
      this.database = new DatabaseSync(filePath);
      this.currentPath = filePath;
      return {
        success: true,
        message: existed
          ? `Database opened: ${filePath}`
          : `Database created: ${filePath} did not exist, so a new empty database was created. If you meant an existing database, check the path, then sqlite_open it.`,
      };
    } catch (error) {
      this.database = undefined;
      this.currentPath = undefined;
      return { success: false, message: `Failed to open database: ${errorMessage(error)}` };
    }
  }

  close(): { success: boolean; message: string } {
    if (!this.database) {
      return { success: false, message: "No database is currently open." };
    }

    try {
      const closedPath = this.currentPath;
      this.database.close();
      this.database = undefined;
      this.currentPath = undefined;
      return { success: true, message: `Database closed: ${closedPath}` };
    } catch (error) {
      return { success: false, message: `Failed to close database: ${errorMessage(error)}` };
    }
  }

  status(): SqliteStatus {
    const db = this.database;
    if (!db) return { isOpen: false, filePath: null, tables: null };

    let tables: number | null = null;
    try {
      tables = (db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).get() as { count: number }).count;
    } catch {
      // A status call should still succeed if SQLite cannot read its catalogue.
    }

    return { isOpen: true, filePath: this.currentPath ?? null, tables };
  }

  query(sql: string, params?: SqlParams): QueryResult {
    const statement = this.getDatabase().prepare(sql);
    if (!isReader(statement)) {
      throw new Error("sqlite_query accepts only statements that return rows. Use sqlite_execute for writes.");
    }

    // Column names come from statement metadata, so duplicate names and empty results keep their shape.
    const columns = statement.columns().map((column) => column.name);
    statement.setReturnArrays(true);
    const rows: unknown[][] = [];
    let bytes = 0;
    let truncated = false;
    // Stream rows and stop at the bounds; breaking out of the iterator resets the statement.
    for (const row of statement.iterate(...(this.bindArgs(params) as never[])) as Iterable<unknown[]>) {
      const values = row.map(boundedValue);
      const rowBytes = values.reduce<number>((total, value) => total + valueBytes(value) + 8, 8);
      if (rows.length >= MAX_QUERY_ROWS) {
        truncated = true;
        break;
      }
      if (bytes + rowBytes > MAX_QUERY_BYTES) {
        if (rows.length === 0) {
          throw new Error(
            `The first row is larger than the ${MAX_QUERY_BYTES}-byte result budget. Select fewer or shorter columns, for example substr(column, 1, N).`,
          );
        }
        truncated = true;
        break;
      }
      bytes += rowBytes;
      rows.push(values);
    }
    return { columns, rows, rowCount: rows.length, ...(truncated ? { truncated: true as const } : {}) };
  }

  execute(sql: string, params?: SqlParams): { changes: number | bigint; lastInsertRowid: number | bigint } {
    const statement = this.getDatabase().prepare(sql);
    if (isReader(statement)) {
      throw new Error("sqlite_execute does not accept statements that return rows. Use sqlite_query instead.");
    }

    const result = statement.run(...(this.bindArgs(params) as never[]));
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  listTables(): { tables: string[] } {
    const rows = this.getDatabase().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[];
    return { tables: rows.map((row) => row.name) };
  }

  describeTable(tableName: string): {
    name: string;
    columns: Array<{
      cid: number;
      name: string;
      type: string;
      notnull: boolean;
      defaultValue: unknown;
      pk: boolean;
    }>;
    rowCount: number;
  } {
    const db = this.getDatabase();
    const quotedName = quoteSqlString(tableName);
    const columns = db.prepare(`PRAGMA table_info(${quotedName})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    if (columns.length === 0) throw new Error(`Table '${tableName}' not found.`);

    const rowCount = (db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get() as {
      count: number;
    }).count;

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

  private getDatabase(): DatabaseSync {
    if (!this.database) {
      throw new Error("No database is currently open. Use sqlite_open to open a database first.");
    }
    return this.database;
  }

  private bindArgs(params?: SqlParams): unknown[] {
    if (params === undefined) return [];
    return Array.isArray(params) ? [...params] : [params];
  }

  private closeIfOpen(): void {
    if (!this.database) return;
    this.database.close();
    this.database = undefined;
    this.currentPath = undefined;
  }
}

function isReader(statement: StatementSync): boolean {
  return statement.columns().length > 0;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
