import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { ToolError } from "../../../shared/src/tool-error/index.js";
import { SqliteStartupError } from "./node-runtime.js";
import { SqliteClient } from "./sqlite-client.js";
import { registerSqliteSettings } from "./settings.js";
import { errorMessage, MAX_BLOB_BYTES, MAX_QUERY_BYTES, MAX_QUERY_ROWS, type SqlParams } from "./sqlite-manager.js";

const MAX_OUTPUT_LINES_TEXT = DEFAULT_MAX_LINES.toLocaleString("en-US");
const MAX_QUERY_ROWS_TEXT = MAX_QUERY_ROWS.toLocaleString("en-US");

const sqliteNamespace = {
  name: "sqlite",
  description: "To read SQLite databases, use tool_search to find and load the sqlite tools.",
};

const manual = `# SQLite tools

This extension is ported from \`easy-sqlite-mcp\` and maintains one SQLite connection per pi session.

## Lifecycle

- Mode: the user may fix the database for the session in advance (fixed mode); otherwise the extension is in manual mode. Fixed settings from an untrusted project are ignored.
- In manual mode, \`sqlite_open\` and \`sqlite_close\` are registered during \`session_start\`. First call \`sqlite_open\` before using SQLite data tools; call \`sqlite_close\` when finished.
- In fixed mode, the extension opens the database the user chose during \`session_start\` and never registers \`sqlite_open\` or \`sqlite_close\`.
- No fixed database means manual mode. Invalid or unreadable user settings, or a failed fixed database open, do not fall back to manual mode; data tools report the error, including without a UI. \`sqlite_status\` and \`sqlite_manual\` remain available.
- Mode and path are pinned for the session's extension instance. After the user changes the database settings, they must use \`/reload\` or restart pi (you cannot reload). Reload/session replacement creates a fresh instance; \`session_shutdown\` closes the previous connection.

## SQL parameters

Both \`sqlite_query\` and \`sqlite_execute\` accept bindings in exactly one style per statement: use a positional array such as \`[42, "Ada"]\` only when every placeholder is \`?\`; or use a named object such as \`{ "id": 42 }\` for \`:id\`, \`@id\`, or \`$id\` placeholders. Do not mix positional and named placeholders in one statement. Pass values in \`bindings\`; \`params\` remains accepted for compatibility.

## Safety

Use \`sqlite_query\` only for statements that return rows; use \`sqlite_execute\` for writes or schema changes. Check \`sqlite_status\` before modifying data and use \`sqlite_list_tables\` or \`sqlite_describe_table\` to inspect an unfamiliar database. Query output is limited to ${MAX_OUTPUT_LINES_TEXT} lines or ${DEFAULT_MAX_BYTES / 1024} KB; use \`LIMIT\` for large results. One query reads at most ${MAX_QUERY_ROWS_TEXT} rows or about ${MAX_QUERY_BYTES / (1024 * 1024)} MiB (the result then carries \`truncated: true\`), and BLOB values over ${MAX_BLOB_BYTES / 1024} KiB are shown as a ${MAX_BLOB_BYTES / 1024} KiB prefix with their \`byteLength\`. Opening a path that does not exist creates a new empty database; the open result says so. Opening never changes the database's journal mode.`;

// Keep this as an unconstrained JSON value at the tool-schema boundary. Pi providers
// can otherwise coerce a TypeBox array/object union to an empty collection before
// execute() receives it. The runtime guard below narrows it before SQLite sees it.
const paramsSchema = Type.Optional(Type.Any({
  description: "Optional SQL bindings. Use an array only when every placeholder is ?, or an object only for :name/@name/$name placeholders. Do not mix both styles; object keys may omit the prefix.",
}));

const statementSchema = (sqlDescription: string) => Type.Object({
  sql: Type.String({ minLength: 1, description: sqlDescription }),
  bindings: paramsSchema,
  params: paramsSchema,
});

const querySchema = statementSchema("A single SQL statement that returns rows (normally SELECT)");
const executeSchema = statementSchema("A single write or schema SQL statement (INSERT, UPDATE, DELETE, CREATE, etc.)");

type StatementInput = Static<typeof querySchema>;

// Output schemas for codemode scripts. Integers that exceed the JS safe range are shown as decimal strings
// (the same conversion the text output uses), hence the number-or-string unions.
const integerOutput = Type.Union([Type.Number(), Type.String()]);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const outputTruncatedField = { outputTruncated: Type.Boolean({ description: "True when the structured rows were cut to match the size-limited text output." }) };
const openOutputSchema = Type.Object({ success: Type.Boolean(), message: Type.String(), ...outputTruncatedField });
const statusOutputSchema = Type.Object({
  isOpen: Type.Boolean(),
  filePath: nullableString,
  tables: Type.Union([Type.Number(), Type.Null()]),
  startupError: Type.Optional(Type.String()),
  hint: Type.Optional(Type.String()),
  ...outputTruncatedField,
});
const queryOutputSchema = Type.Object({
  columns: Type.Array(Type.String()),
  rows: Type.Array(Type.Array(Type.Unknown())),
  rowCount: Type.Number({ description: "Rows read by the query (before any output cut)." }),
  truncated: Type.Optional(Type.Boolean({ description: "Present (true) when the read stopped at the row or byte cap; more rows exist." })),
  hint: Type.Optional(Type.String()),
  ...outputTruncatedField,
});
const executeOutputSchema = Type.Object({ changes: integerOutput, lastInsertRowid: integerOutput, ...outputTruncatedField });
const listTablesOutputSchema = Type.Object({ tables: Type.Array(Type.String()), ...outputTruncatedField });
const describeTableOutputSchema = Type.Object({
  name: Type.String(),
  columns: Type.Array(Type.Object({
    cid: Type.Number(),
    name: Type.String(),
    type: Type.String(),
    notnull: Type.Boolean(),
    defaultValue: Type.Unknown(),
    pk: Type.Boolean(),
  })),
  rowCount: integerOutput,
  ...outputTruncatedField,
});
const manualOutputSchema = Type.Object({ manual: Type.String() });

function normalizePath(input: string, cwd: string): string {
  const path = input.startsWith("@") ? input.slice(1) : input;
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

type FixedDatabase = { filePath: string; source: string };

/**
 * A startup problem with two wordings: `message` is agent-facing and never names settings files, keys or environment
 * variables; `humanMessage` keeps those exact names and is shown only in the human UI.
 */
class SetupError extends Error {
  constructor(message: string, readonly humanMessage: string) {
    super(message);
  }
}

async function resolveFixedDatabase(ctx: ExtensionContext): Promise<FixedDatabase | undefined> {
  const environmentPath = process.env.SQLITE_PATH?.trim();
  if (environmentPath) {
    return { filePath: normalizePath(environmentPath, ctx.cwd), source: "SQLITE_PATH" };
  }

  // Do not even read project-authored configuration without project trust.
  if (!ctx.isProjectTrusted()) return undefined;

  const configPath = join(ctx.cwd, CONFIG_DIR_NAME, "agent", "sqlite.json");
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const code = (error as NodeJS.ErrnoException).code;
    throw new SetupError(`Cannot read the SQLite project settings${code ? ` (${code})` : ""}.`, `Cannot read SQLite config ${configPath}: ${errorMessage(error)}`);
  }

  const invalid = (agentDetail: string, humanDetail: string) => new SetupError(`Invalid SQLite project settings: ${agentDetail}`, `Invalid SQLite config ${configPath}: ${humanDetail}`);
  let config: unknown;
  try {
    // Accept a UTF-8 BOM, which some Windows editors add to JSON files.
    config = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw invalid("they are not valid JSON.", errorMessage(error));
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw invalid("expected a JSON object with a non-empty database path string.", "Expected a JSON object with a non-empty databasePath string.");
  }
  const databasePath = (config as Record<string, unknown>).databasePath;
  if (typeof databasePath !== "string" || !databasePath.trim()) {
    throw invalid("the database path must be a non-empty string.", "databasePath must be a non-empty string.");
  }
  return { filePath: resolve(ctx.cwd, databasePath), source: configPath };
}

function asParams(params: unknown): SqlParams | undefined {
  if (params === undefined) return undefined;
  if (Array.isArray(params)) return params;
  if (params !== null && typeof params === "object") return params as Record<string, unknown>;
  const received = params === null ? "null" : typeof params;
  throw new ToolError("SQLITE_INVALID_BINDINGS", `SQL bindings must be an array for positional placeholders or an object for named placeholders; received ${received}. Pass the values in the "bindings" field as [v1, v2] for ? placeholders or {"name": value} for :name/@name/$name placeholders.`);
}

function getBindings(input: StatementInput): SqlParams | undefined {
  // `bindings` avoids a transport-level `params` field collision in some tool clients.
  if (input.bindings !== undefined && input.params !== undefined) {
    throw new ToolError("SQLITE_INVALID_BINDINGS", "Both `bindings` and `params` were given; they are aliases and only one is used. Pass the values in `bindings` and omit `params`.");
  }
  return asParams(input.bindings ?? input.params);
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Uint8Array) return { type: "Buffer", data: [...item] };
    return item;
  }, 2);
}

const OUTPUT_DIRECTORY = "pi-sqlite-tools";
/** Saved full outputs are for follow-up reads in the same work session, not long-term storage. */
export const OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Upper bound of stat calls per sweep; foreign names are skipped without a stat and do not count. */
const MAX_SWEEP_STATS = 2048;
const OUTPUT_NAME = /^[0-9a-f-]{36}\.json$/;

/**
 * Best effort: removes saved outputs older than the retention period; never blocks a result.
 * The work per call is bounded. Directory order is arbitrary, so beyond the bound the start rotates (`startAt`, 0..1)
 * and an expired file listed late is reached by a later call instead of being skipped forever.
 */
export async function sweepOldOutputs(directory: string, now = Date.now(), startAt = Math.random()): Promise<void> {
  try {
    const candidates = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && OUTPUT_NAME.test(entry.name));
    const first = candidates.length <= MAX_SWEEP_STATS ? 0 : Math.floor(Math.min(Math.max(startAt, 0), 0.999999) * candidates.length);
    const picked = [...candidates.slice(first), ...candidates.slice(0, first)].slice(0, MAX_SWEEP_STATS);
    for (const entry of picked) {
      const path = join(directory, entry.name);
      try {
        if (now - (await stat(path)).mtimeMs > OUTPUT_RETENTION_MS) await rm(path, { force: true });
      } catch { /* another process may have removed it */ }
    }
  } catch { /* housekeeping only */ }
}

async function formatResult(value: unknown) {
  const output = json(value);
  const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncation.truncated) return { text: output, truncated: false };

  const directory = join(tmpdir(), OUTPUT_DIRECTORY);
  const outputPath = join(directory, `${randomUUID()}.json`);
  await mkdir(directory, { recursive: true });
  await sweepOldOutputs(directory);
  await writeFile(outputPath, output, "utf8");

  return {
    text: `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`,
    truncated: true,
  };
}

/**
 * The structured value of a result: the same JSON the text is rendered from. When the text was cut, the array at
 * `arrayKey` keeps only the longest prefix whose JSON still fits the text limits, so it never carries more than the text.
 */
function structuredFor(value: unknown, textTruncated: boolean, arrayKey: string | undefined): Record<string, unknown> {
  const normalized = JSON.parse(json(value)) as Record<string, unknown>;
  if (!textTruncated) return { ...normalized, outputTruncated: false };
  const items = arrayKey ? normalized[arrayKey] : undefined;
  if (!Array.isArray(items)) return { ...normalized, outputTruncated: true };
  const fits = (count: number) => !truncateHead(json({ ...normalized, [arrayKey!]: items.slice(0, count) }), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES }).truncated;
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle; else high = middle - 1;
  }
  return { ...normalized, [arrayKey!]: items.slice(0, low), outputTruncated: true };
}

export default function sqliteExtension(pi: ExtensionAPI) {
  registerSqliteSettings(pi);
  const manager = new SqliteClient();
  let startupError: string | undefined = "SQLite tools are not initialized. Wait for session_start.";
  let startup: Promise<void> | undefined;
  let stopped = false;
  let manualToolsRegistered = false;

  /** What an agent should do about the current startup state (undefined when ready). */
  let startupHint: string | undefined = "Wait for session_start, then call this tool again.";

  function ensureReady(): void {
    if (startupError) throw new ToolError("SQLITE_NOT_READY", startupError);
  }

  async function result<S extends TSchema>(_schema: S, value: unknown, arrayKey?: string) {
    const output = await formatResult(value);
    return {
      content: [{ type: "text" as const, text: output.text }],
      structuredContent: structuredFor(value, output.truncated, arrayKey) as unknown as Static<S> & JsonValue,
      details: { outputTruncated: output.truncated },
    };
  }

  function registerManualTools(): void {
    if (manualToolsRegistered) return;
    manualToolsRegistered = true;
    pi.registerTool({
      exposure: "deferred",
      namespace: sqliteNamespace,
      name: "sqlite_open",
      label: "Open SQLite Database",
      description: "Open one SQLite database file. Replaces and closes the previously open database, if any.",
      promptSnippet: "Open an SQLite database for the sqlite_* tools",
      promptGuidelines: ["In manual mode, use sqlite_open before other SQLite data tools. Fixed mode does not provide sqlite_open or sqlite_close."],
      parameters: Type.Object({
        file_path: Type.String({ minLength: 1, description: "Absolute or project-relative SQLite database path" }),
      }),
      outputSchema: openOutputSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        ensureReady();
        const filePath = normalizePath(params.file_path, ctx.cwd);
        return result(openOutputSchema, await manager.open(filePath, signal));
      },
    });

    pi.registerTool({
      exposure: "deferred",
      namespace: sqliteNamespace,
      name: "sqlite_close",
      label: "Close SQLite Database",
      description: "Close the currently open SQLite database connection.",
      parameters: Type.Object({}),
      outputSchema: openOutputSchema,
      async execute(_id, _params, signal) {
        ensureReady();
        return result(openOutputSchema, await manager.close(signal));
      },
    });
  }

  pi.registerTool({
    exposure: "deferred",
    namespace: sqliteNamespace,
    name: "sqlite_status",
    label: "SQLite Database Status",
    description: "Report whether a database is open, its resolved path, and its user-table count.",
    promptSnippet: "Check the active SQLite connection and database summary",
    parameters: Type.Object({}),
    outputSchema: statusOutputSchema,
    async execute(_id, _params, signal) {
      const status = await manager.status(signal);
      if (status.isOpen) return result(statusOutputSchema, status);
      return result(statusOutputSchema, {
        ...status,
        ...(startupError ? { startupError } : {}),
        hint: startupHint ?? "No database is open. In manual mode call sqlite_open with a file_path; otherwise ask the user to fix a database for this session in the SQLite database settings and run /reload.",
      });
    },
  });

  pi.registerTool({
    exposure: "deferred",
    namespace: sqliteNamespace,
    name: "sqlite_query",
    label: "Query SQLite Database",
    description: `Execute one SQL statement that returns rows, normally SELECT. Pass bindings as either an array for every ? placeholder or an object for every :name/@name/$name placeholder; never mix styles. Reads at most ${MAX_QUERY_ROWS_TEXT} rows (truncated: true when cut); output is truncated to ${MAX_OUTPUT_LINES_TEXT} lines or ${DEFAULT_MAX_BYTES / 1024} KB.`,
    promptSnippet: "Read rows from the active SQLite database",
    promptGuidelines: ["Use sqlite_query only for SQL that returns rows; use sqlite_execute for mutations."],
    parameters: querySchema,
    outputSchema: queryOutputSchema,
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      ensureReady();
      return result(queryOutputSchema, await manager.query(params.sql, getBindings(params), signal), "rows");
    },
  });

  pi.registerTool({
    exposure: "deferred",
    namespace: sqliteNamespace,
    name: "sqlite_execute",
    label: "Execute SQLite Statement",
    description: "Execute one non-row-returning SQLite write or schema statement (INSERT, UPDATE, DELETE, CREATE, etc.). Pass bindings as either an array for every ? placeholder or an object for every :name/@name/$name placeholder; never mix styles.",
    promptSnippet: "Modify data or schema in the active SQLite database",
    promptGuidelines: ["Use sqlite_execute only after confirming the active database with sqlite_status when the operation changes data or schema."],
    parameters: executeSchema,
    outputSchema: executeOutputSchema,
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      ensureReady();
      return result(executeOutputSchema, await manager.execute(params.sql, getBindings(params), signal));
    },
  });

  pi.registerTool({
    exposure: "deferred",
    namespace: sqliteNamespace,
    name: "sqlite_list_tables",
    label: "List SQLite Tables",
    description: "List non-system tables in the active SQLite database.",
    parameters: Type.Object({}),
    outputSchema: listTablesOutputSchema,
    async execute(_id, _params, signal) {
      ensureReady();
      return result(listTablesOutputSchema, await manager.listTables(signal), "tables");
    },
  });

  pi.registerTool({
    exposure: "deferred",
    namespace: sqliteNamespace,
    name: "sqlite_describe_table",
    label: "Describe SQLite Table",
    description: "Show a table's columns, primary-key metadata, defaults, and row count.",
    parameters: Type.Object({
      table_name: Type.String({ minLength: 1, description: "Exact table name to inspect" }),
    }),
    outputSchema: describeTableOutputSchema,
    async execute(_id, params, signal) {
      ensureReady();
      return result(describeTableOutputSchema, await manager.describeTable(params.table_name, signal), "columns");
    },
  });

  pi.registerTool({
    exposure: "deferred",
    namespace: sqliteNamespace,
    name: "sqlite_manual",
    label: "SQLite Tools Manual",
    description: "Explain the SQLite tool lifecycle, parameter binding, safety rules, and output limits.",
    parameters: Type.Object({}),
    outputSchema: manualOutputSchema,
    async execute() {
      return { content: [{ type: "text", text: manual }], structuredContent: { manual }, details: {} };
    },
  });

  async function initialize(ctx: ExtensionContext): Promise<void> {
    try {
      const fixedDatabase = await resolveFixedDatabase(ctx);
      if (stopped) return;
      if (fixedDatabase) {
        const opened = await manager.open(fixedDatabase.filePath);
        if (!opened.success) {
          throw new SetupError(
            `Could not open the SQLite database the user configured (${fixedDatabase.filePath}): ${opened.message}`,
            `Could not open SQLite database from ${fixedDatabase.source} (${fixedDatabase.filePath}): ${opened.message}`,
          );
        }
      } else {
        registerManualTools();
      }
      startupError = undefined;
      startupHint = undefined;
    } catch (error) {
      if (stopped) return;
      if (error instanceof SqliteStartupError) {
        // The helper process could not start: an environment problem, not a database setting.
        startupHint = "The SQLite helper process could not be started. This is a problem with the user's Node.js environment that the agent cannot fix: ask the user to resolve it and run /reload. Do not fall back to another database.";
        startupError = `${error.message} Ask the user to fix the Node.js environment, then run /reload (the agent cannot reload).`;
        if (ctx.hasUI) ctx.ui.notify(`${error.humanMessage} Fix the environment, then run /reload (the agent cannot reload).`, "error");
        return;
      }
      startupHint = "The SQLite database could not be set up. This is a problem with the user's database settings that the agent cannot fix: ask the user to correct them and run /reload. Do not fall back to another database.";
      startupError = `${errorMessage(error)} Ask the user to fix the SQLite database settings, then run /reload (the agent cannot reload).`;
      // Human-only UI notice: keeps the exact settings file path and variable name.
      if (ctx.hasUI) ctx.ui.notify(`${error instanceof SetupError ? error.humanMessage : errorMessage(error)} Ask the user to fix the config file or SQLITE_PATH, then run /reload (the agent cannot reload).`, "error");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    // Pin mode for this extension instance. Pi creates a new instance on reload
    // and session replacement; duplicate events must not change its tool set.
    return startup ??= initialize(ctx);
  });

  pi.on("session_shutdown", () => {
    stopped = true;
    startupError = "SQLite session has shut down; the session has ended and this tool can no longer be used. Start a new session.";
    startupHint = "The session has ended; start a new session to use SQLite tools.";
    return manager.dispose();
  });
}
