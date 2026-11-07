import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { bottomConfirm } from "../../../shared/src/bottom-panel/index.js";
import { describeUnexpectedError } from "./driver-errors.js";
import { formatRows, MAX_BYTES, MAX_STRING_CHARS } from "./output.js";
import { assertReadOnlySql, assertUpdateSql, MAX_READ_ROWS } from "./security/sql-policy.js";
import { SqlConnectorRuntime } from "./runtime.js";
import { ENGINE_LABEL, SqlConnectorError, type Engine, type SqlScalar } from "./types.js";

const scalarSchema = Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String()]);
const positionalParamsSchema = () => Type.Optional(Type.Array(scalarSchema));
const namedParamsSchema = () => Type.Optional(Type.Record(Type.String(), scalarSchema));
type ParamsSchema = ReturnType<typeof positionalParamsSchema> | ReturnType<typeof namedParamsSchema>;
const makeQuerySchema = (params: ParamsSchema) => Type.Object({ sql: Type.String({ minLength: 1 }), params });
const makeUpdateSchema = (params: ParamsSchema) =>
  Type.Object({ sql: Type.String({ minLength: 1 }), params, reason: Type.String({ minLength: 1 }) });
const mysqlOrPgsqlQuerySchema = makeQuerySchema(positionalParamsSchema());
const mssqlQuerySchema = makeQuerySchema(namedParamsSchema());
const mysqlOrPgsqlUpdateSchema = makeUpdateSchema(positionalParamsSchema());
const mssqlUpdateSchema = makeUpdateSchema(namedParamsSchema());

const stateOutputSchema = Type.Object({
  connected: Type.Boolean(),
  engine: Type.String(),
  database: Type.Union([Type.String(), Type.Null()]),
  version: Type.Union([Type.String(), Type.Null()]),
});
const queryOutputSchema = Type.Object({
  columns: Type.Array(Type.String()),
  rows: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  returnedRows: Type.Number(),
  totalRows: Type.Union([Type.Number(), Type.Null()]),
  truncated: Type.Boolean(),
  hint: Type.Optional(Type.String()),
});
const updateOutputSchema = Type.Object({ affectedRows: Type.Number() });

const engineLabel = (engine: Engine): string => ENGINE_LABEL[engine];

function throwSafe(error: unknown): never {
  if (error instanceof SqlConnectorError) throw error;
  throw describeUnexpectedError(error);
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
    throw new SqlConnectorError("POLICY_DENIED", "Database updates require an interactive confirmation, and this session has no interactive UI, so the update cannot run here. Do not retry; ask the user to run it in an interactive Pi session or to execute the statement themselves.");
  }
  const parameterNames = Array.isArray(params)
    ? params.map((_value, index) => `$${index + 1}`).join(", ") || "none"
    : Object.keys(params ?? {}).join(", ") || "none";
  const confirmed = await bottomConfirm(
    ctx,
    `Confirm ${engineLabel(engine)} update`,
    `Reason: ${reason}\n\nSQL:\n${sql}\n\nParameter names: ${parameterNames}`,
    { signal: ctx.signal },
  );
  if (!confirmed) {
    throw new SqlConnectorError("CONFIRMATION_DENIED", "Database update was not confirmed by the user, so nothing was changed. Do not retry the same statement unless the user asks; ask what to change.");
  }
}

export function registerEngineTools(pi: ExtensionAPI, runtime: SqlConnectorRuntime, engine: Engine, guidance?: string): void {
  const prefix = engine;
  const positional = engine === "mysql" || engine === "pgsql";
  const querySchema = positional ? mysqlOrPgsqlQuerySchema : mssqlQuerySchema;
  const updateSchema = positional ? mysqlOrPgsqlUpdateSchema : mssqlUpdateSchema;
  const placeholder = engine === "mysql" ? "?" : engine === "mssql" ? "@name" : "$1, $2, ...";
  const paramsDescription = positional ? "ordered JSON array" : "JSON object whose keys omit @";
  const readLimit = engine === "mssql" ? `TOP n, where n is 1 to ${MAX_READ_ROWS}` : `LIMIT n, where n is 1 to ${MAX_READ_ROWS}`;
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
    outputSchema: stateOutputSchema,
    async execute(_toolCallId, _params, signal) {
      checkAborted(signal);
      try {
        const state = await runtime.state(engine, signal);
        checkAborted(signal);
        return {
          content: [{ type: "text", text: JSON.stringify({ connected: true, ...state }, null, 2) }],
          structuredContent: { connected: true, ...state },
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
    description: `Run one read-only SQL statement against the configured ${engineLabel(engine)} database. Use ${placeholder} placeholders and an ${paramsDescription} for params. SELECT queries must include ${readLimit}. Results are limited to ${MAX_READ_ROWS} rows or ${MAX_BYTES / 1024} KiB; columns named like password/secret/token are returned as [REDACTED] and strings over ${MAX_STRING_CHARS.toLocaleString("en-US")} characters are cut with an ellipsis.`,
    promptSnippet: `Run read-only ${engineLabel(engine)} SQL with ${placeholder} placeholders and ${readLimit}`,
    parameters: querySchema,
    outputSchema: queryOutputSchema,
    async execute(_toolCallId, params, signal) {
      checkAborted(signal);
      try {
        assertReadOnlySql(engine, params.sql);
        const execution = await runtime.query(engine, params.sql, params.params, signal);
        checkAborted(signal);
        const formatted = formatRows(execution.rows, execution.rowCount);
        return {
          content: [{ type: "text", text: formatted.text }],
          // Rows were normalised to JSON values by formatRows.
          structuredContent: formatted.structured as unknown as JsonValue,
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
    description: `Run one INSERT, UPDATE, or DELETE statement against the configured ${engineLabel(engine)} database after explicit user confirmation (the reason is shown to the user in the confirmation dialog; non-interactive sessions cannot run updates). Use ${placeholder} placeholders and an ${paramsDescription} for params.`,
    promptSnippet: `Run a confirmed ${engineLabel(engine)} INSERT, UPDATE, or DELETE`,
    executionMode: "sequential",
    parameters: updateSchema,
    outputSchema: updateOutputSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      checkAborted(signal);
      try {
        assertUpdateSql(engine, params.sql);
        await confirmUpdate(engine, params.sql, params.params, params.reason, ctx);
        checkAborted(signal);
        const execution = await runtime.update(engine, params.sql, params.params, signal);
        return {
          content: [{ type: "text", text: JSON.stringify({ affectedRows: execution.affectedRows }, null, 2) }],
          structuredContent: { affectedRows: execution.affectedRows },
          details: { affectedRows: execution.affectedRows },
        };
      } catch (error) {
        return throwSafe(error);
      }
    },
  });
}
