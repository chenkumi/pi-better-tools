import mssql from "mssql";
import { createRequire } from "node:module";
import mysql from "mysql2/promise";
import { Pool as PgPool, type PoolClient, type QueryConfig } from "pg";
import type { DatabaseConfig, Engine, QueryExecution, SqlConnectorConfig, SqlScalar, StateExecution, UpdateExecution } from "./types.js";
import { SqlConnectorError } from "./types.js";

const QUERY_TIMEOUT_MS = 30_000;
/** Bounded waiting for a pooled connection; a full queue fails instead of growing without limit. */
const MYSQL_QUEUE_LIMIT = 32;
const require = createRequire(import.meta.url);
type QueryParams = SqlScalar[] | Record<string, SqlScalar> | undefined;

/**
 * Always use the extended query protocol. Without values, node-postgres otherwise sends a
 * simple query, which the server executes as a multi-statement batch.
 */
export function pgQueryConfig(sql: string, params: SqlScalar[] | undefined): QueryConfig & { queryMode: "extended" } {
  return { text: sql, values: params ?? [], queryMode: "extended" };
}

/** mysql2 executes one prepared statement; the client-side timeout bounds reads only (see README). */
export function mysqlReadOptions(sql: string): { sql: string; timeout: number } {
  return { sql, timeout: QUERY_TIMEOUT_MS };
}

interface Adapter {
  state(signal?: AbortSignal): Promise<StateExecution>;
  query(sql: string, params: QueryParams, signal?: AbortSignal): Promise<QueryExecution>;
  update(sql: string, params: QueryParams, signal?: AbortSignal): Promise<UpdateExecution>;
  close(): Promise<void>;
}

function rowsFrom(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row));
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SqlConnectorError("TIMEOUT", "The database request was cancelled.");
}

function databaseError(engine: Engine, error: unknown, signal?: AbortSignal): never {
  if (error instanceof SqlConnectorError) throw error;
  if (signal?.aborted) throw new SqlConnectorError("TIMEOUT", `${engine} request was cancelled.`);

  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (/(timeout|etimedout|esocket|econnreset)/i.test(code)) {
    throw new SqlConnectorError("TIMEOUT", `${engine} request timed out or the connection was interrupted.`);
  }
  if (/(access_denied|elogin|28p01|authentication|certificate|tls)/i.test(code)) {
    throw new SqlConnectorError("AUTH_OR_TLS", `${engine} authentication or TLS configuration failed.`);
  }
  if (/(econnrefused|enotfound|ehostunreach)/i.test(code)) {
    throw new SqlConnectorError("CONNECTIVITY", `${engine} database connection failed.`);
  }
  throw new SqlConnectorError("DRIVER_INTERNAL", `${engine} database request failed.`);
}

class MysqlAdapter implements Adapter {
  private readonly pool: mysql.Pool;

  constructor(private readonly config: DatabaseConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.ssl ? {} : undefined,
      waitForConnections: true,
      connectionLimit: 4,
      queueLimit: MYSQL_QUEUE_LIMIT,
      connectTimeout: 10_000,
      multipleStatements: false,
    });
  }

  private async withConnection<T>(signal: AbortSignal | undefined, operation: (connection: mysql.PoolConnection) => Promise<T>): Promise<T> {
    aborted(signal);
    const connection = await this.pool.getConnection();
    let destroyed = false;
    const onAbort = () => {
      destroyed = true;
      connection.destroy();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      aborted(signal);
      return await operation(connection);
    } catch (error) {
      // A timed-out or failed connection may still be running the statement or hold an open
      // transaction: never return it to the pool.
      if (!destroyed) {
        destroyed = true;
        connection.destroy();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (!destroyed) connection.release();
    }
  }

  async state(signal?: AbortSignal): Promise<StateExecution> {
    try {
      const [rows] = await this.withConnection(signal, (connection) =>
        connection.query("SELECT VERSION() AS version, DATABASE() AS current_database"),
      );
      const row = rowsFrom(rows)[0];
      return { engine: "mysql", database: row?.current_database ? String(row.current_database) : (this.config.database ?? null), version: row?.version ? String(row.version) : null };
    } catch (error) {
      return databaseError("mysql", error, signal);
    }
  }

  async query(sql: string, params: QueryParams, signal?: AbortSignal): Promise<QueryExecution> {
    if (params !== undefined && !Array.isArray(params)) {
      throw new SqlConnectorError("POLICY_DENIED", "mysql_query params must be a JSON array.");
    }
    try {
      const [rows] = await this.withConnection(signal, async (connection) => {
        // Defense in depth behind the SQL policy: the server rejects writes to non-temporary tables.
        await connection.query("START TRANSACTION READ ONLY");
        const result = await connection.execute(mysqlReadOptions(sql), params ?? []);
        await connection.query("ROLLBACK");
        return result;
      });
      return { rows: rowsFrom(rows), rowCount: rowsFrom(rows).length };
    } catch (error) {
      return databaseError("mysql", error, signal);
    }
  }

  async update(sql: string, params: QueryParams, signal?: AbortSignal): Promise<UpdateExecution> {
    if (params !== undefined && !Array.isArray(params)) {
      throw new SqlConnectorError("POLICY_DENIED", "mysql_update params must be a JSON array.");
    }
    try {
      const [result] = await this.withConnection(signal, (connection) => connection.execute(sql, params ?? []));
      const affectedRows = typeof result === "object" && result !== null && "affectedRows" in result
        ? Number((result as { affectedRows?: unknown }).affectedRows ?? 0)
        : 0;
      return { affectedRows };
    } catch (error) {
      return databaseError("mysql", error, signal);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class MssqlAdapter implements Adapter {
  private readonly pool: mssql.ConnectionPool;
  private connecting?: Promise<unknown>;

  constructor(private readonly config: DatabaseConfig) {
    // ODBC native bindings are optional; load them only for Windows Authentication.
    const driver: typeof mssql = config.windowsAuth ? require("mssql/msnodesqlv8") : mssql;
    const poolConfig = {
      server: config.host,
      ...(config.port === undefined ? {} : { port: config.port }),
      ...(config.windowsAuth ? { driver: config.odbcDriver } : { user: config.username, password: config.password }),
      database: config.database,
      connectionTimeout: 10_000,
      requestTimeout: QUERY_TIMEOUT_MS,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
      options: {
        encrypt: config.ssl,
        trustServerCertificate: config.trustServerCertificate,
        ...(config.instanceName ? { instanceName: config.instanceName } : {}),
        ...(config.windowsAuth ? { trustedConnection: true } : {}),
      },
    };
    this.pool = new driver.ConnectionPool(poolConfig as never);
  }

  private async connectedPool(signal?: AbortSignal): Promise<mssql.ConnectionPool> {
    aborted(signal);
    if (!this.pool.connected) {
      const connecting = this.connecting ??= this.pool.connect().finally(() => {
        if (this.connecting === connecting) this.connecting = undefined;
      });
      await connecting;
    }
    aborted(signal);
    return this.pool;
  }

  private bind(request: mssql.Request, params: QueryParams): void {
    if (params === undefined) return;
    if (Array.isArray(params)) {
      throw new SqlConnectorError("POLICY_DENIED", "mssql_query and mssql_update params must be a JSON object.");
    }
    for (const [name, value] of Object.entries(params)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SqlConnectorError("POLICY_DENIED", "MSSQL parameter names must contain only letters, numbers, and underscores.");
      }
      request.input(name, value);
    }
  }

  private async runRequest<T>(request: mssql.Request, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    aborted(signal);
    const onAbort = () => request.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await operation();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async state(signal?: AbortSignal): Promise<StateExecution> {
    try {
      const request = (await this.connectedPool(signal)).request();
      const result = await this.runRequest(request, signal, () => request.query("SELECT @@VERSION AS version, DB_NAME() AS current_database"));
      const row = rowsFrom(result.recordset)[0];
      return { engine: "mssql", database: row?.current_database ? String(row.current_database) : (this.config.database ?? null), version: row?.version ? String(row.version) : null };
    } catch (error) {
      return databaseError("mssql", error, signal);
    }
  }

  async query(sql: string, params: QueryParams, signal?: AbortSignal): Promise<QueryExecution> {
    try {
      const request = (await this.connectedPool(signal)).request();
      this.bind(request, params);
      const result = await this.runRequest(request, signal, () => request.query(sql));
      return { rows: rowsFrom(result.recordset), rowCount: result.rowsAffected?.[0] ?? rowsFrom(result.recordset).length };
    } catch (error) {
      return databaseError("mssql", error, signal);
    }
  }

  async update(sql: string, params: QueryParams, signal?: AbortSignal): Promise<UpdateExecution> {
    try {
      const request = (await this.connectedPool(signal)).request();
      this.bind(request, params);
      const result = await this.runRequest(request, signal, () => request.query(sql));
      return { affectedRows: result.rowsAffected?.reduce((sum, value) => sum + value, 0) ?? 0 };
    } catch (error) {
      return databaseError("mssql", error, signal);
    }
  }

  async close(): Promise<void> {
    // mssql refuses to close a connecting pool; wait for that attempt, then close what it opened.
    await this.connecting?.catch(() => undefined);
    if (this.pool.connected) await this.pool.close();
  }
}

class PgsqlAdapter implements Adapter {
  private readonly pool: PgPool;

  constructor(private readonly config: DatabaseConfig) {
    this.pool = new PgPool({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: QUERY_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
    });
  }

  private async withClient<T>(signal: AbortSignal | undefined, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    aborted(signal);
    const client = await this.pool.connect();
    let released = false;
    const onAbort = () => {
      released = true;
      client.release(new Error("SQL connector request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      aborted(signal);
      return await operation(client);
    } catch (error) {
      // Discard a client that failed mid-transaction instead of pooling its unknown state.
      if (!released) {
        released = true;
        client.release(error instanceof Error ? error : new Error("SQL connector request failed"));
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (!released) client.release();
    }
  }

  async state(signal?: AbortSignal): Promise<StateExecution> {
    try {
      const result = await this.withClient(signal, (client) =>
        client.query("SELECT version() AS version, current_database() AS database"),
      );
      const row = rowsFrom(result.rows)[0];
      return { engine: "pgsql", database: row?.database ? String(row.database) : (this.config.database ?? null), version: row?.version ? String(row.version) : null };
    } catch (error) {
      return databaseError("pgsql", error, signal);
    }
  }

  async query(sql: string, params: QueryParams, signal?: AbortSignal): Promise<QueryExecution> {
    if (params !== undefined && !Array.isArray(params)) {
      throw new SqlConnectorError("POLICY_DENIED", "pgsql_query params must be a JSON array.");
    }
    try {
      const result = await this.withClient(signal, async (client) => {
        // Defense in depth behind the SQL policy: one extended-protocol statement in a read-only transaction.
        await client.query("BEGIN READ ONLY");
        const rows = await client.query(pgQueryConfig(sql, params));
        await client.query("ROLLBACK");
        return rows;
      });
      return { rows: rowsFrom(result.rows), rowCount: result.rowCount };
    } catch (error) {
      return databaseError("pgsql", error, signal);
    }
  }

  async update(sql: string, params: QueryParams, signal?: AbortSignal): Promise<UpdateExecution> {
    if (params !== undefined && !Array.isArray(params)) {
      throw new SqlConnectorError("POLICY_DENIED", "pgsql_update params must be a JSON array.");
    }
    try {
      const result = await this.withClient(signal, (client) => client.query(pgQueryConfig(sql, params)));
      return { affectedRows: result.rowCount ?? 0 };
    } catch (error) {
      return databaseError("pgsql", error, signal);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class SqlConnectorRuntime {
  private readonly adapters = new Map<Engine, Adapter>();
  private readonly creating = new Map<Engine, Promise<Adapter>>();
  private closing = false;

  constructor(private readonly config: SqlConnectorConfig) {}

  async state(engine: Engine, signal?: AbortSignal): Promise<StateExecution> {
    return (await this.adapter(engine)).state(signal);
  }

  async query(engine: Engine, sql: string, params: QueryParams, signal?: AbortSignal): Promise<QueryExecution> {
    return (await this.adapter(engine)).query(sql, params, signal);
  }

  async update(engine: Engine, sql: string, params: QueryParams, signal?: AbortSignal): Promise<UpdateExecution> {
    return (await this.adapter(engine)).update(sql, params, signal);
  }

  async close(): Promise<void> {
    this.closing = true;
    const adapters = new Set(this.adapters.values());
    const pending = await Promise.allSettled([...this.creating.values()]);
    for (const result of pending) {
      if (result.status === "fulfilled") adapters.add(result.value);
    }
    await Promise.allSettled([...adapters].map((adapter) => adapter.close()));
    this.adapters.clear();
    this.creating.clear();
  }

  private async adapter(engine: Engine): Promise<Adapter> {
    if (this.closing) throw new SqlConnectorError("CONNECTIVITY", "The SQL connector is shutting down.");
    const existing = this.adapters.get(engine);
    if (existing) return existing;

    const creating = this.creating.get(engine);
    if (creating) return creating;

    const config = this.config[engine];
    if (!config) throw new SqlConnectorError("ENGINE_NOT_CONFIGURED", `${engine} is not configured.`);

    const promise = Promise.resolve().then(() => {
      const adapter: Adapter = engine === "mysql"
        ? new MysqlAdapter(config)
        : engine === "mssql"
          ? new MssqlAdapter(config)
          : new PgsqlAdapter(config);
      if (this.closing) {
        void adapter.close();
        throw new SqlConnectorError("CONNECTIVITY", "The SQL connector is shutting down.");
      }
      this.adapters.set(engine, adapter);
      this.creating.delete(engine);
      return adapter;
    });
    this.creating.set(engine, promise);
    return promise;
  }
}
