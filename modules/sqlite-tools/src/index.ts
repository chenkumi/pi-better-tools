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
import { Type, type Static } from "typebox";
import { SqliteManager, type SqlParams } from "./sqlite-manager.js";

const sqliteNamespace = {
  name: "sqlite",
  description: "To read SQLite databases, use tool_search to find and load the sqlite tools.",
};

const manual = `# SQLite tools

This extension is ported from \`easy-sqlite-mcp\` and maintains one SQLite connection per pi session.

## Lifecycle

- Priority: non-blank \`SQLITE_PATH\` > trusted project \`.pi/agent/sqlite.json\` > manual mode. An untrusted project's config is not read; \`SQLITE_PATH\` still applies.
- Project config must be a JSON object such as \`{"databasePath":"./data/app.sqlite"}\` with a non-empty string. Database paths may be absolute or relative to the session working directory, not the config directory.
- In manual mode, \`sqlite_open\` and \`sqlite_close\` are registered during \`session_start\`. First call \`sqlite_open\` before using SQLite data tools; call \`sqlite_close\` when finished.
- In either fixed mode, the extension opens the configured database during \`session_start\` and never registers \`sqlite_open\` or \`sqlite_close\`.
- Missing config means manual mode. Invalid/unreadable config or a failed fixed database open does not fall back to manual mode; data tools report the error, including without a UI. \`sqlite_status\` and \`sqlite_manual\` remain available.
- Mode and path are pinned for the session's extension instance. After changing project config, use \`/reload\` or restart pi. Reload/session replacement creates a fresh instance; \`session_shutdown\` closes the previous connection.

## SQL parameters

Both \`sqlite_query\` and \`sqlite_execute\` accept bindings in exactly one style per statement: use a positional array such as \`[42, "Ada"]\` only when every placeholder is \`?\`; or use a named object such as \`{ "id": 42 }\` for \`:id\`, \`@id\`, or \`$id\` placeholders. Do not mix positional and named placeholders in one statement. Pass values in \`bindings\`; \`params\` remains accepted for compatibility.

## Safety

Use \`sqlite_query\` only for statements that return rows; use \`sqlite_execute\` for writes or schema changes. Check \`sqlite_status\` before modifying data and use \`sqlite_list_tables\` or \`sqlite_describe_table\` to inspect an unfamiliar database. Query output is limited to 2,000 lines or 50 KB; use \`LIMIT\` for large results. One query reads at most 10,000 rows or about 8 MiB (the result then carries \`truncated: true\`), and BLOB values over 1 KiB are shown as a 1 KiB prefix with their \`byteLength\`. Opening a path that does not exist creates a new empty database; the open result says so. Opening never changes the database's journal mode.`;

// Keep this as an unconstrained JSON value at the tool-schema boundary. Pi providers
// can otherwise coerce a TypeBox array/object union to an empty collection before
// execute() receives it. The runtime guard below narrows it before SQLite sees it.
const paramsSchema = Type.Optional(Type.Any({
  description: "Optional SQL bindings. Use an array only when every placeholder is ?, or an object only for :name/@name/$name placeholders. Do not mix both styles; object keys may omit the prefix.",
}));

const querySchema = Type.Object({
  sql: Type.String({ minLength: 1, description: "A single SQL statement that returns rows (normally SELECT)" }),
  bindings: paramsSchema,
  params: paramsSchema,
});

type QueryInput = Static<typeof querySchema>;

const executeSchema = Type.Object({
  sql: Type.String({ minLength: 1, description: "A single write or schema SQL statement (INSERT, UPDATE, DELETE, CREATE, etc.)" }),
  bindings: paramsSchema,
  params: paramsSchema,
});

type ExecuteInput = Static<typeof executeSchema>;

function normalizePath(input: string, cwd: string): string {
  const path = input.startsWith("@") ? input.slice(1) : input;
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

type FixedDatabase = { filePath: string; source: string };

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
    throw new Error(`Cannot read SQLite config ${configPath}: ${errorMessage(error)}`);
  }

  try {
    // Accept a UTF-8 BOM, which some Windows editors add to JSON files.
    const config: unknown = JSON.parse(contents.replace(/^\uFEFF/, ""));
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Expected a JSON object with a non-empty databasePath string.");
    }
    const databasePath = (config as Record<string, unknown>).databasePath;
    if (typeof databasePath !== "string" || !databasePath.trim()) {
      throw new Error("databasePath must be a non-empty string.");
    }
    return { filePath: resolve(ctx.cwd, databasePath), source: configPath };
  } catch (error) {
    throw new Error(`Invalid SQLite config ${configPath}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asParams(params: unknown): SqlParams | undefined {
  if (params === undefined) return undefined;
  if (Array.isArray(params)) return params;
  if (params !== null && typeof params === "object") return params as Record<string, unknown>;
  throw new Error("SQL bindings must be an array for positional placeholders or an object for named placeholders.");
}

function getBindings(input: QueryInput | ExecuteInput): SqlParams | undefined {
  // `bindings` avoids a transport-level `params` field collision in some tool clients.
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
const MAX_SWEEP_ENTRIES = 256;

/** Best effort: removes saved outputs older than the retention period; never blocks a result. */
export async function sweepOldOutputs(directory: string, now = Date.now()): Promise<void> {
  try {
    let scanned = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++scanned > MAX_SWEEP_ENTRIES) break;
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue;
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

export default function sqliteExtension(pi: ExtensionAPI) {
  const manager = new SqliteManager();
  let startupError: string | undefined = "SQLite tools are not initialized. Wait for session_start.";
  let startup: Promise<void> | undefined;
  let stopped = false;
  let manualToolsRegistered = false;

  function ensureReady(): void {
    if (startupError) throw new Error(startupError);
  }

  async function result(value: unknown) {
    const output = await formatResult(value);
    return {
      content: [{ type: "text" as const, text: output.text }],
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
      async execute(_id, params, _signal, _onUpdate, ctx) {
        ensureReady();
        const filePath = normalizePath(params.file_path, ctx.cwd);
        return result(manager.open(filePath));
      },
    });

    pi.registerTool({
      exposure: "deferred",
      namespace: sqliteNamespace,
      name: "sqlite_close",
      label: "Close SQLite Database",
      description: "Close the currently open SQLite database connection.",
      parameters: Type.Object({}),
      async execute() {
        ensureReady();
        return result(manager.close());
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
    async execute() {
      return result(manager.status());
    },
  });

  pi.registerTool({
    exposure: "deferred",
    namespace: sqliteNamespace,
    name: "sqlite_query",
    label: "Query SQLite Database",
    description: "Execute one SQL statement that returns rows, normally SELECT. Pass bindings as either an array for every ? placeholder or an object for every :name/@name/$name placeholder; never mix styles. Reads at most 10,000 rows (truncated: true when cut); output is truncated to 2,000 lines or 50 KB.",
    promptSnippet: "Read rows from the active SQLite database",
    promptGuidelines: ["Use sqlite_query only for SQL that returns rows; use sqlite_execute for mutations."],
    parameters: querySchema,
    async execute(_id, params) {
      ensureReady();
      return result(manager.query(params.sql, getBindings(params)));
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
    async execute(_id, params) {
      ensureReady();
      return result(manager.execute(params.sql, getBindings(params)));
    },
  });

  pi.registerTool({
    exposure: "deferred",
    namespace: sqliteNamespace,
    name: "sqlite_list_tables",
    label: "List SQLite Tables",
    description: "List non-system tables in the active SQLite database.",
    parameters: Type.Object({}),
    async execute() {
      ensureReady();
      return result(manager.listTables());
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
    async execute(_id, params) {
      ensureReady();
      return result(manager.describeTable(params.table_name));
    },
  });

  pi.registerTool({
    exposure: "deferred",
    namespace: sqliteNamespace,
    name: "sqlite_manual",
    label: "SQLite Tools Manual",
    description: "Explain the SQLite tool lifecycle, parameter binding, safety rules, and output limits.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: manual }], details: {} };
    },
  });

  async function initialize(ctx: ExtensionContext): Promise<void> {
    try {
      const fixedDatabase = await resolveFixedDatabase(ctx);
      if (stopped) return;
      if (fixedDatabase) {
        const opened = manager.open(fixedDatabase.filePath);
        if (!opened.success) {
          throw new Error(`Could not open SQLite database from ${fixedDatabase.source} (${fixedDatabase.filePath}): ${opened.message}`);
        }
      } else {
        registerManualTools();
      }
      startupError = undefined;
    } catch (error) {
      if (stopped) return;
      startupError = errorMessage(error);
      if (ctx.hasUI) ctx.ui.notify(startupError, "error");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    // Pin mode for this extension instance. Pi creates a new instance on reload
    // and session replacement; duplicate events must not change its tool set.
    return startup ??= initialize(ctx);
  });

  pi.on("session_shutdown", () => {
    stopped = true;
    startupError = "SQLite session has shut down.";
    manager.close();
  });
}
