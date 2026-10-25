export type SqlParams = readonly unknown[] | Record<string, unknown>;

/** node:sqlite reads synchronously: bound how much one query may materialize. */
export const MAX_QUERY_ROWS: number;
export const MAX_QUERY_BYTES: number;
/** BLOB values longer than this are returned as a prefix plus their length. */
export const MAX_BLOB_BYTES: number;
/** Bounded wait for another connection's lock. */
export const BUSY_TIMEOUT_MS: number;

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  /** Present when the result was cut at MAX_QUERY_ROWS or MAX_QUERY_BYTES; more rows exist. */
  truncated?: true;
  /** Present with `truncated`: how to narrow the query. */
  hint?: string;
}

export interface ExecuteResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatus {
  isOpen: boolean;
  filePath: string | null;
  tables: number | null;
}

export interface TableDescription {
  name: string;
  columns: Array<{ cid: number; name: string; type: string; notnull: boolean; defaultValue: unknown; pk: boolean }>;
  rowCount: number;
}

/** Manages one synchronous SQLite connection. Runs in the SQLite child process, never on the Pi thread. */
export class SqliteManager {
  open(filePath: string): { success: boolean; message: string };
  close(): { success: boolean; message: string };
  status(): SqliteStatus;
  query(sql: string, params?: SqlParams): QueryResult;
  execute(sql: string, params?: SqlParams): ExecuteResult;
  listTables(): { tables: string[] };
  describeTable(tableName: string): TableDescription;
}

export function errorMessage(error: unknown): string;
