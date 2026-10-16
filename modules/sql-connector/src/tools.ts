import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatRows } from "./output.js";
import { assertReadOnlySql, assertUpdateSql } from "./security/sql-policy.js";
import { SqlConnectorRuntime } from "./runtime.js";
import { SqlConnectorError, type Engine, type SqlScalar } from "./types.js";

const scalarSchema = Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String()]);
const mysqlOrPgsqlQuerySchema = Type.Object({
  sql: Type.String({ minLength: 1 }),
  params: Type.Optional(Type.Array(scalarSchema)),
});
const mssqlQuerySchema = Type.Object({
  sql: Type.String({ minLength: 1 }),
  params: Type.Optional(Type.Record(Type.String(), scalarSchema)),
});
const mysqlOrPgsqlUpdateSchema = Type.Object({
  sql: Type.String({ minLength: 1 }),
  params: Type.Optional(Type.Array(scalarSchema)),
  reason: Type.String({ minLength: 1 }),
});
const mssqlUpdateSchema = Type.Object({
  sql: Type.String({ minLength: 1 }),
  params: Type.Optional(Type.Record(Type.String(), scalarSchema)),
  reason: Type.String({ minLength: 1 }),
});

function engineLabel(engine: Engine): string {
  return engine === "mysql" ? "MySQL" : engine === "mssql" ? "Microsoft SQL Server" : "PostgreSQL";
}

function throwSafe(error: unknown): never {
  if (error instanceof SqlConnectorError) throw error;
  throw new SqlConnectorError("DRIVER_INTERNAL", "SQL connector request failed.");
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("SQL connector request was cancelled.");
}

async function confirmUpdate(
  engine: Engine,
  sql: string,
  params: SqlScalar[] | Record<string, SqlScalar> | undefined,
  reason: string,
  ctx: ExtensionContext,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new SqlConnectorError("POLICY_DENIED", "Database updates require an interactive confirmation.");
  }
  const parameterNames = Array.isArray(params)
    ? params.map((_value, index) => `$${index + 1}`).join(", ") || "none"
    : Object.keys(params ?? {}).join(", ") || "none";
  const confirmed = await ctx.ui.confirm(
    `Confirm ${engineLabel(engine)} update`,
    `Reason: ${reason}\n\nSQL:\n${sql}\n\nParameter names: ${parameterNames}`,
    { signal: ctx.signal },
  );
  if (!confirmed) {
    throw new SqlConnectorError("CONFIRMATION_DENIED", "Database update was not confirmed.");
  }
}

export function registerEngineTools(pi: ExtensionAPI, runtime: SqlConnectorRuntime, engine: Engine, guidance?: string): void {
  const prefix = engine;
  const positional = engine === "mysql" || engine === "pgsql";
  const querySchema = positional ? mysqlOrPgsqlQuerySchema : mssqlQuerySchema;
  const updateSchema = positional ? mysqlOrPgsqlUpdateSchema : mssqlUpdateSchema;
  const placeholder = engine === "mysql" ? "?" : engine === "mssql" ? "@name" : "$1, $2, ...";
  const paramsDescription = positional ? "ordered JSON array" : "JSON object whose keys omit @";
  const readLimit = engine === "mssql" ? "TOP n, where n is 1 to 200" : "LIMIT n, where n is 1 to 200";
  const namespace = {
    name: engine,
    description: `${engineLabel(engine)} database tools. Use tool_search to find and load ${engine} tools before accessing this database.`,
  };

  pi.registerTool({
    exposure: "deferred",
    namespace,
    name: `${prefix}_state`,
    label: `${engineLabel(engine)} State`,
    description: `Check connectivity and server state for the configured ${engineLabel(engine)} database.`,
    promptSnippet: `Check the configured ${engineLabel(engine)} database state`,
    promptGuidelines: guidance ? [guidance] : [],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      checkAborted(signal);
      try {
        const state = await runtime.state(engine, signal);
        checkAborted(signal);
        return {
          content: [{ type: "text", text: JSON.stringify({ connected: true, ...state }, null, 2) }],
          details: { connected: true, ...state },
        };
      } catch (error) {
        return throwSafe(error);
      }
    },
  });

  pi.registerTool({
    exposure: "deferred",
    namespace,
    name: `${prefix}_query`,
    label: `${engineLabel(engine)} Query`,
    description: `Run one read-only SQL statement against the configured ${engineLabel(engine)} database. Use ${placeholder} placeholders and an ${paramsDescription} for params. SELECT queries must include ${readLimit}. Results are limited to 200 rows or 48 KiB.`,
    promptSnippet: `Run read-only ${engineLabel(engine)} SQL with ${placeholder} placeholders and ${readLimit}`,
    parameters: querySchema,
    async execute(_toolCallId, params, signal) {
      checkAborted(signal);
      try {
        assertReadOnlySql(engine, params.sql);
        const execution = await runtime.query(engine, params.sql, params.params, signal);
        checkAborted(signal);
        const formatted = formatRows(execution.rows, execution.rowCount);
        return {
          content: [{ type: "text", text: formatted.text }],
          details: formatted.details,
        };
      } catch (error) {
        return throwSafe(error);
      }
    },
  });

  pi.registerTool({
    exposure: "deferred",
    namespace,
    name: `${prefix}_update`,
    label: `${engineLabel(engine)} Update`,
    description: `Run one INSERT, UPDATE, or DELETE statement against the configured ${engineLabel(engine)} database after explicit user confirmation. Use ${placeholder} placeholders and an ${paramsDescription} for params.`,
    promptSnippet: `Run a confirmed ${engineLabel(engine)} INSERT, UPDATE, or DELETE`,
    executionMode: "sequential",
    parameters: updateSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      checkAborted(signal);
      try {
        assertUpdateSql(engine, params.sql);
        await confirmUpdate(engine, params.sql, params.params, params.reason, ctx);
        checkAborted(signal);
        const execution = await runtime.update(engine, params.sql, params.params, signal);
        return {
          content: [{ type: "text", text: JSON.stringify({ affectedRows: execution.affectedRows }, null, 2) }],
          details: { affectedRows: execution.affectedRows },
        };
      } catch (error) {
        return throwSafe(error);
      }
    },
  });
}
