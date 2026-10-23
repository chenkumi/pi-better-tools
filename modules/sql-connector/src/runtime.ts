import mssql from "mssql";
import { createRequire } from "node:module";
import mysql from "mysql2/promise";
import { Pool as PgPool, type PoolClient, type QueryConfig } from "pg";
import type { DatabaseConfig, Engine, QueryExecution, SqlConnectorConfig, SqlScalar, StateExecution, UpdateExecution } from "./types.js";
import { SqlConnectorError } from "./types.js";

const QUERY_TIMEOUT_MS = 30_000;
/** Pool sizing and connection timing shared by every engine's driver pool. */
const POOL_MAX_CONNECTIONS = 4;
const CONNECT_TIMEOUT_MS = 10_000;
const POOL_IDLE_TIMEOUT_MS = 30_000;
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

/** MySQL and PostgreSQL bind positional parameters only. */
function assertPositionalParams(params: QueryParams, tool: string): asserts params is SqlScalar[] | undefined {
  if (params !== undefined && !Array.isArray(params)) {
    throw new SqlConnectorError("POLICY_DENIED", `${tool} params must be a JSON array.`);
  }
}

/** Server-reported database and version, falling back to the configured database name. */
function stateFrom(engine: Engine, row: Record<string, unknown> | undefined, databaseColumn: string, configuredDatabase: string | undefined): StateExecution {
  return { engine, database: row?.[databaseColumn] ? String(row[databaseColumn]) : (configuredDatabase ?? null), version: row?.version ? String(row.version) : null };
}

const shuttingDown = () => new SqlConnectorError("CONNECTIVITY", "The SQL connector is shutting down.");

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
      connectionLimit: POOL_MAX_CONNECTIONS,
      queueLimit: MYSQL_QUEUE_LIMIT,
      connectTimeout: CONNECT_TIMEOUT_MS,
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
      return stateFrom("mysql", rowsFrom(rows)[0], "current_database", this.config.database);
    } catch (error) {
      return databaseError("mysql", error, signal);
    }
  }

  async query(sql: string, params: QueryParams, signal?: AbortSignal): Promise<QueryExecution> {
    assertPositionalParams(params, "mysql_query");
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
    assertPositionalParams(params, "mysql_update");
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
      connectionTimeout: CONNECT_TIMEOUT_MS,
      requestTimeout: QUERY_TIMEOUT_MS,
      pool: { max: POOL_MAX_CONNECTIONS, min: 0, idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS },
      options: {
        encrypt: config.ssl,
        trustServerCertificate: config.trustServerCertificate,
        ...(config.instanceName ? { instanceName: config.instanceName } : {}),
        ...(config.windowsAuth ? { trustedConnection: true } : {}),
      },
    };
    this.pool = new driver.ConnectionPool(poolConfig as never);
    // An unhandled 'error' event would crash the host process; request failures are still reported by each call.
    this.pool.on("error", () => {});
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
      return stateFrom("mssql", rowsFrom(result.recordset)[0], "current_database", this.config.database);
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
      max: POOL_MAX_CONNECTIONS,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
    });
    // pg-pool emits 'error' when an idle client is terminated; without a listener it would crash the host process.
    // The failed client is already removed from the pool, so the next request simply opens a new connection.
    this.pool.on("error", () => {});
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
      return stateFrom("pgsql", rowsFrom(result.rows)[0], "database", this.config.database);
    } catch (error) {
      return databaseError("pgsql", error, signal);
    }
  }

  async query(sql: string, params: QueryParams, signal?: AbortSignal): Promise<QueryExecution> {
    assertPositionalParams(params, "pgsql_query");
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
    assertPositionalParams(params, "pgsql_update");
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
    if (this.closing) throw shuttingDown();
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
        throw shuttingDown();
      }
      this.adapters.set(engine, adapter);
      this.creating.delete(engine);
      return adapter;
    });
    // A failed construction (e.g. an optional native driver that cannot load) must not be cached: the next call
    // retries instead of repeating the same rejection until reload. Concurrent callers of this attempt still share it.
    promise.catch(() => { if (this.creating.get(engine) === promise) this.creating.delete(engine); });
    this.creating.set(engine, promise);
    return promise;
  }
}
